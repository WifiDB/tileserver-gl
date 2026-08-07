#!/usr/bin/env python3
"""
libtorrent sidecar for pmtiles-swarm.

Node has no maintained libtorrent binding — the packages on npm are abandoned
2022 stubs — so this exposes libtorrent over a line-delimited JSON protocol on
stdin/stdout instead. The parent process spawns it and speaks to it over the
pipe; there is no port to secure and the sidecar dies with its parent.

The protocol is deliberately dull, because the point is that it can be
reimplemented behind a real N-API addon later without the Node side noticing:

    -> {"id": 1, "op": "add", "params": {...}}
    <- {"id": 1, "ok": true, "result": {...}}
    <- {"id": 1, "ok": false, "error": "..."}

What libtorrent buys over WebTorrent, and why this exists at all:

  * BitTorrent v2 and hybrid torrents (BEP 52), both creating and joining.
  * Piece-level control — set_piece_deadline, read_piece — which is what
    on-demand tile reads want and which qBittorrent's WebUI does not expose.
  * Resume data, so a restart does not re-hash the entire store.
  * Bulk seeding at multi-terabyte scale.

Requires: python3 and libtorrent (Debian/Ubuntu: apt install python3-libtorrent;
macOS: brew install libtorrent-rasterbar; or pip install libtorrent).
"""

import base64
import json
import os
import sys
import threading
import time

try:
    import libtorrent as lt
except ImportError:  # pragma: no cover - environment dependent
    sys.stderr.write(
        "python3 libtorrent bindings not found. Install python3-libtorrent "
        "(Debian/Ubuntu), libtorrent-rasterbar (Homebrew), or pip install libtorrent.\n"
    )
    sys.exit(2)


# libtorrent reports many states; the parent only distinguishes these.
STATE_MAP = {
    lt.torrent_status.checking_files: "checking",
    lt.torrent_status.downloading_metadata: "downloading",
    lt.torrent_status.downloading: "downloading",
    lt.torrent_status.finished: "seeding",
    lt.torrent_status.seeding: "seeding",
    lt.torrent_status.checking_resume_data: "checking",
}


class Sidecar:
    """Owns the libtorrent session and answers requests from the parent."""

    def __init__(self, settings):
        self._lock = threading.Lock()
        self._handles = {}
        self._resume_dir = settings.get("resumeDir")

        pack = {
            "listen_interfaces": settings.get("listen", "0.0.0.0:6881"),
            "alert_mask": lt.alert.category_t.error_notification
            | lt.alert.category_t.storage_notification
            | lt.alert.category_t.status_notification,
            "enable_dht": settings.get("dht", True),
            "enable_lsd": settings.get("lsd", True),
            "enable_upnp": settings.get("upnp", True),
            "enable_natpmp": settings.get("natpmp", True),
        }
        if settings.get("uploadLimit"):
            pack["upload_rate_limit"] = int(settings["uploadLimit"])
        if settings.get("downloadLimit"):
            pack["download_rate_limit"] = int(settings["downloadLimit"])
        # Every peer is a NAT table entry. Consumer routers run out of those
        # long before bandwidth becomes the limit, so this is the knob that
        # decides whether seeding disrupts the rest of the network.
        if settings.get("maxConnections"):
            pack["connections_limit"] = int(settings["maxConnections"])

        self._session = lt.session(pack)
        if self._resume_dir:
            os.makedirs(self._resume_dir, exist_ok=True)

    # ---- operations -----------------------------------------------------

    def op_version(self, _params):
        """Report versions, so the parent can check compatibility."""
        return {"libtorrent": lt.__version__, "python": sys.version.split()[0]}

    def op_add(self, params):
        """Add a torrent from raw .torrent bytes or a magnet URI."""
        save_path = params.get("savePath") or "."
        os.makedirs(save_path, exist_ok=True)

        if params.get("torrentFile"):
            raw = base64.b64decode(params["torrentFile"])
            info = lt.torrent_info(lt.bdecode(raw))
            atp = lt.add_torrent_params()
            atp.ti = info
        else:
            atp = lt.parse_magnet_uri(params["magnet"])

        atp.save_path = save_path

        # Cache mode joins the swarm without committing the disk to a full
        # copy. This must be file priority 0 rather than upload_mode: upload
        # mode refuses to download anything at all, which would break the whole
        # point, because read_piece raises an individual piece back to priority
        # 7 to fetch it on demand. Priority 0 means "do not fetch this
        # proactively", which still allows that.
        cache_mode = params.get("mode") == "cache"
        if cache_mode:
            if atp.ti is not None:
                atp.file_priorities = [0] * atp.ti.num_files()
            # A torrent with nothing wanted looks idle to the auto-manager,
            # which pauses it — and a paused torrent stops seeding. Cache mode
            # must stay active precisely so it can serve the pieces it holds.
            atp.flags &= ~lt.torrent_flags.auto_managed
            atp.flags &= ~lt.torrent_flags.paused

        if params.get("paused"):
            atp.flags |= lt.torrent_flags.paused

        # Resume data skips re-hashing an existing store, which on a large
        # archive is the difference between seconds and many minutes.
        resume = self._read_resume(params.get("infoHash"))
        if resume:
            atp = lt.read_resume_data(resume)
            atp.save_path = save_path

        handle = self._session.add_torrent(atp)

        # A magnet has no metadata yet, so file priorities cannot be set until
        # it arrives. Apply them once it does, otherwise a cache-mode magnet
        # would quietly start downloading the whole archive.
        if cache_mode and atp.ti is None:
            threading.Thread(
                target=self._deprioritise_when_ready, args=(handle,), daemon=True
            ).start()

        info_hash = str(handle.info_hash())
        with self._lock:
            self._handles[info_hash] = handle
        return {"infoHash": info_hash}

    def _deprioritise_when_ready(self, handle, timeout=300):
        """Set every file to priority 0 once metadata arrives."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if handle.has_metadata():
                try:
                    handle.prioritize_files([0] * handle.torrent_file().num_files())
                except Exception:  # noqa: BLE001 - best effort
                    pass
                return
            time.sleep(1)

    def op_remove(self, params):
        """Remove a torrent, optionally deleting its data."""
        handle = self._handle(params["infoHash"])
        flags = lt.options_t.delete_files if params.get("deleteData") else 0
        self._session.remove_torrent(handle, flags)
        with self._lock:
            self._handles.pop(params["infoHash"], None)
        return {"removed": True}

    def op_list(self, _params):
        """Report the state of every torrent in the session."""
        return [self._status(h) for h in self._session.get_torrents()]

    def op_get(self, params):
        """Report one torrent's state."""
        try:
            return self._status(self._handle(params["infoHash"]))
        except KeyError:
            return None

    def op_peers(self, params):
        """Report per-peer detail for one torrent."""
        handle = self._handle(params["infoHash"])
        out = []
        for peer in handle.get_peer_info():
            out.append(
                {
                    "address": f"{peer.ip[0]}:{peer.ip[1]}",
                    "client": peer.client.decode() if isinstance(peer.client, bytes) else str(peer.client),
                    "progress": peer.progress,
                    "downloadSpeed": peer.down_speed,
                    "uploadSpeed": peer.up_speed,
                    "connection": "utp" if peer.flags & peer.utp_socket else "tcp",
                }
            )
        return out

    def op_create(self, params):
        """
        Create a torrent from a local file.

        Defaults to a hybrid v1+v2 torrent: v2 brings per-file merkle trees
        with 16 KiB leaf blocks, so a peer can verify a small block without the
        whole hash list, while the v1 half keeps every existing client working.
        This is the main thing create-torrent cannot do.
        """
        path = params["path"]
        piece_length = int(params.get("pieceLength", 4 * 1024 * 1024))

        storage = lt.file_storage()
        lt.add_files(storage, path)

        flags = 0
        fmt = params.get("format", "hybrid")
        if fmt == "v1":
            flags |= lt.create_torrent.v1_only
        elif fmt == "v2":
            flags |= lt.create_torrent.v2_only

        creator = lt.create_torrent(storage, piece_length, flags=flags)
        for tracker in params.get("trackers", []):
            creator.add_tracker(tracker)
        for seed in params.get("webSeeds", []):
            creator.add_url_seed(seed)
        if params.get("comment"):
            creator.set_comment(params["comment"])
        creator.set_creator("pmtiles-swarm")

        lt.set_piece_hashes(creator, os.path.dirname(path) or ".")
        entry = creator.generate()
        raw = lt.bencode(entry)
        info = lt.torrent_info(entry)

        return {
            "torrentFile": base64.b64encode(raw).decode(),
            "infoHash": str(info.info_hash()),
            "name": info.name(),
            "size": info.total_size(),
            "pieceLength": info.piece_length(),
            "pieceCount": info.num_pieces(),
            "format": fmt,
        }

    def op_read_piece(self, params):
        """
        Read one piece, prioritising it ahead of everything else.

        set_piece_deadline is the primitive that makes on-demand tile serving
        work: it promotes a piece to the front of the queue rather than waiting
        for the normal picker. qBittorrent's API has no equivalent.
        """
        handle = self._handle(params["infoHash"])
        index = int(params["piece"])
        deadline = int(params.get("deadlineMs", 1000))

        handle.piece_priority(index, 7)
        handle.set_piece_deadline(index, deadline, lt.deadline_flags_t.alert_when_available)

        timeout = time.time() + float(params.get("timeoutMs", 60000)) / 1000
        while time.time() < timeout:
            alert = self._session.wait_for_alert(500)
            if alert is None:
                continue
            for item in self._session.pop_alerts():
                if isinstance(item, lt.read_piece_alert) and item.piece == index:
                    if item.error.value() != 0:
                        raise RuntimeError(f"piece {index}: {item.error.message()}")
                    return {"piece": index, "data": base64.b64encode(item.buffer).decode()}
        raise TimeoutError(f"timed out waiting for piece {index}")

    def op_set_priority(self, params):
        """
        Set the download priority of a piece range.

        This is what background hydration is built on: a range at priority 1
        is fetched when there is nothing more urgent, and dropping it back to 0
        stops it competing the moment a real read arrives. libtorrent exposes
        this per piece; qBittorrent's API has nothing equivalent, which is why
        it cannot do on-demand reads properly.
        """
        handle = self._handle(params["infoHash"])
        first = int(params["first"])
        last = int(params["last"])
        priority = int(params.get("priority", 0))

        for index in range(first, last + 1):
            handle.piece_priority(index, priority)
            if priority == 0:
                # Clear any deadline too, or a previously urgent piece keeps
                # its place in the queue despite having no priority.
                handle.reset_piece_deadline(index)
        return {"pieces": last - first + 1, "priority": priority}

    def op_info(self, params):
        """Report the geometry a reader needs to map byte ranges onto pieces."""
        handle = self._handle(params["infoHash"])
        if not handle.status().has_metadata:
            raise RuntimeError("metadata has not arrived yet")

        info = handle.torrent_file()
        index = int(params.get("fileIndex", 0))
        entry = info.files()

        return {
            "infoHash": str(handle.info_hash()),
            "pieceLength": info.piece_length(),
            "numPieces": info.num_pieces(),
            "name": entry.file_name(index),
            "fileLength": entry.file_size(index),
            "fileOffset": entry.file_offset(index),
            "numFiles": info.num_files(),
        }

    def op_save_resume(self, params):
        """Persist resume data for one torrent, or all of them."""
        handles = (
            [self._handle(params["infoHash"])]
            if params.get("infoHash")
            else self._session.get_torrents()
        )
        saved = 0
        for handle in handles:
            if handle.need_save_resume_data():
                handle.save_resume_data()
                saved += 1
        # Alerts carry the actual data; drain briefly to collect them.
        deadline = time.time() + 5
        while saved > 0 and time.time() < deadline:
            self._session.wait_for_alert(500)
            for alert in self._session.pop_alerts():
                if isinstance(alert, lt.save_resume_data_alert):
                    self._write_resume(str(alert.handle.info_hash()), alert.params)
                    saved -= 1
                elif isinstance(alert, lt.save_resume_data_failed_alert):
                    saved -= 1
        return {"saved": True}

    def op_shutdown(self, _params):
        """Persist resume data and stop."""
        try:
            self.op_save_resume({})
        finally:
            del self._session
        return {"stopped": True}

    # ---- helpers --------------------------------------------------------

    def _handle(self, info_hash):
        with self._lock:
            handle = self._handles.get(info_hash)
        if handle is None:
            for candidate in self._session.get_torrents():
                if str(candidate.info_hash()) == info_hash:
                    return candidate
            raise KeyError(f"no such torrent: {info_hash}")
        return handle

    def _status(self, handle):
        s = handle.status()

        # torrent_status.paused is deprecated in libtorrent 2.x and reports
        # unreliably; the live value lives on the handle's flags.
        paused = bool(handle.flags() & lt.torrent_flags.paused)

        # A torrent whose files are all priority 0 is in cache mode: joined and
        # seeding whatever it holds, but fetching nothing on its own. Reporting
        # that as "paused" would be misleading — it is working as intended.
        has_metadata = s.has_metadata
        cache_mode = has_metadata and s.total_wanted == 0

        if paused:
            state = "paused"
        elif cache_mode:
            state = "cache"
        else:
            state = STATE_MAP.get(s.state, "stalled")

        return {
            "infoHash": str(handle.info_hash()),
            "name": s.name,
            # total_wanted is zero in cache mode, so report the real size.
            "size": handle.torrent_file().total_size() if has_metadata else s.total_wanted,
            "progress": s.progress,
            "state": state,
            "peers": max(0, s.num_peers - s.num_seeds),
            "seeds": s.num_seeds,
            "downloadSpeed": s.download_rate,
            "uploadSpeed": s.upload_rate,
            "downloaded": s.total_done,
            "uploaded": s.all_time_upload,
            "ratio": (s.all_time_upload / s.total_done) if s.total_done else 0,
            "savePath": s.save_path,
        }

    def _resume_path(self, info_hash):
        if not self._resume_dir or not info_hash:
            return None
        return os.path.join(self._resume_dir, f"{info_hash}.resume")

    def _read_resume(self, info_hash):
        path = self._resume_path(info_hash)
        if not path or not os.path.exists(path):
            return None
        with open(path, "rb") as handle:
            return handle.read()

    def _write_resume(self, info_hash, params):
        path = self._resume_path(info_hash)
        if not path:
            return
        with open(path, "wb") as handle:
            handle.write(lt.write_resume_data_buf(params))


def main():
    """Read requests from stdin, write responses to stdout, one JSON per line."""
    settings = json.loads(os.environ.get("SIDECAR_SETTINGS", "{}"))
    sidecar = Sidecar(settings)

    # Announce readiness so the parent does not have to guess.
    print(json.dumps({"event": "ready", "libtorrent": lt.__version__}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            print(json.dumps({"id": None, "ok": False, "error": f"bad request: {error}"}), flush=True)
            continue

        request_id = request.get("id")
        op = request.get("op", "")
        handler = getattr(sidecar, f"op_{op}", None)
        if handler is None:
            print(json.dumps({"id": request_id, "ok": False, "error": f"unknown op: {op}"}), flush=True)
            continue

        try:
            result = handler(request.get("params") or {})
            print(json.dumps({"id": request_id, "ok": True, "result": result}), flush=True)
        except Exception as error:  # noqa: BLE001 - report everything to the parent
            print(json.dumps({"id": request_id, "ok": False, "error": str(error)}), flush=True)

        if op == "shutdown":
            break


if __name__ == "__main__":
    main()
