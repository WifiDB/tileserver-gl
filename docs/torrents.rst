===============================
Serving PMTiles over BitTorrent
===============================

*tileserver-gl* can read a PMTiles archive directly from a BitTorrent swarm, without
downloading it first. Tiles are served on demand by fetching only the pieces that contain
them, so a 700 GiB planet archive can be served from a machine with a fraction of that
disk free.

This works because the two formats line up well. PMTiles is read as a series of byte
ranges; BitTorrent serves data as fixed-size, individually verified pieces. The mapping
between them lives in the ``pmtiles-torrent`` package, in ``packages/pmtiles-torrent``.

Quick start
===========

Point ``--file`` at a magnet URI or a ``.torrent`` file:

.. code-block:: bash

  # From a .torrent file (recommended - connects immediately)
  tileserver-gl --file /data/planet.pmtiles.torrent

  # From a magnet URI
  tileserver-gl --file "magnet:?xt=urn:btih:5e1c...&dn=planet.pmtiles&tr=udp://tracker.example:1337"

Or as a data source in ``config.json``:

.. code-block:: json

  {
    "data": {
      "planet": {
        "pmtiles": "magnet:?xt=urn:btih:5e1c...&dn=planet.pmtiles"
      }
    }
  }

.. note::

   On Windows ``cmd.exe``, always use **double** quotes. Single quotes are not string
   delimiters there and become part of the argument, and an unquoted magnet is split at
   every ``&``. In PowerShell, use single quotes, since ``&`` is an operator.

Prefer a ``.torrent`` file over a magnet
----------------------------------------

Both work, but they start very differently. A magnet carries only an infohash, so the
client must first find peers and complete a BEP 9 metadata exchange before it knows
anything about the archive. Measured against a 72 GiB archive, that took between 90 and
240 seconds. A ``.torrent`` file already contains the metadata, so the same archive was
ready immediately and had a peer within 15 seconds.

If you have the ``.torrent``, use it.

How tiles are served
====================

Each tile request becomes one or more piece fetches:

* The requested byte range is expanded to the pieces covering it, and those pieces are
  fetched **concurrently**. A range spanning three pieces costs one round trip, not three.
* Pieces are cached in memory and shared between concurrent requests, so several tiles
  landing in the same piece cost one fetch.
* Cancelling a tile request is reference counted. An abandoned request stops waiting
  immediately, but the underlying fetch is only cancelled once every waiter has gone, so
  one cancelled request cannot starve another that is still waiting on the same piece.
* Because PMTiles stores tiles in Hilbert order, a piece fetched for one tile usually
  contains its map neighbours. The read amplification inherent to piece-granular
  transport therefore doubles as prefetch.

Directory hydration
-------------------

Every tile lookup in a new region needs a leaf-directory read first. Having the leaf
directories locally is a large win, but fetching them eagerly is actively harmful: on a
bandwidth-constrained swarm the bulk transfer starves the very requests it is meant to
accelerate. Measured on a 72 GiB archive against a single peer, eager prefetch took a
cold tile from 34 seconds to 138 seconds.

Leaf directories are therefore *hydrated*: queued at the lowest priority, started only
after the source has been idle for a couple of seconds, and withdrawn the moment a tile
request arrives.

Immutability
------------

An infohash is a hash of the archive's content, so the bytes behind a given torrent can
never change. Ranges are returned with the infohash as their ETag and
``cache-control: immutable``, and the ETag-mismatch retry path that HTTP range sources
need is structurally unreachable.

The corollary is that a rebuilt archive is always a *different* torrent. See
``pmtiles-swarm`` for feeds and BEP 46 records that carry subscribers across rebuilds.

Configuration
=============

Torrent behaviour is configured through environment variables rather than the config
file, so it can be set per deployment:

``PMTILES_TORRENT_PATH``
    Directory for downloaded pieces. **Set this.** Without it, WebTorrent uses a
    temporary directory and everything is re-fetched on restart.

    Pointing it at a directory that already holds the complete archive makes the tile
    server verify what is there and immediately **seed** it, rather than downloading it
    again.

``PMTILES_TORRENT_RESUME_PATH``
    Where resume data is stored. Defaults to ``PMTILES_TORRENT_PATH``. See
    :ref:`torrent-startup` below - this is what keeps startup fast.

``PMTILES_TORRENT_CACHE_PIECES``
    How many pieces to hold in memory per archive. Default ``8``.

    The budget is ``max(64 MiB, cachePieces × pieceLength)``, counted in pieces rather
    than bytes on purpose: large archives are routinely cut at 16 MiB per piece, where a
    fixed 64 MiB budget holds only four pieces and one directory read evicts the tile
    pieces fetched moments earlier. At 16 MiB pieces the default is 128 MiB per archive;
    raise it on a dedicated server, remembering it is per archive.

``PMTILES_TORRENT_LEAF_PREFETCH_MB``
    Upper bound on the leaf-directory region to hydrate in the background. Default
    ``256``. Safe to be generous, because hydration never competes with a request.

``PMTILES_TORRENT_HYDRATE_IDLE_MS``
    How long with no reads in flight before hydration resumes. Default ``2000``.

``PMTILES_TORRENT_READY_TIMEOUT_MS``
    How long to wait for torrent metadata. Default ``300000`` (5 minutes), which is
    generous because a magnet must complete a BEP 9 exchange first.

``PMTILES_TORRENT_MAX_CONNS``
    Maximum peer connections. Default ``50``.

    This, rather than piece size, is what decides how hard the server leans on
    network equipment: every peer is a NAT table entry, and consumer routers run out
    of those long before bandwidth becomes the limit. Lower it if the network
    misbehaves while seeding.

``PMTILES_TORRENT_MAX_WEB_CONNS``
    Simultaneous connections per web seed. Default ``8``; WebTorrent's own default is 4.
    See :ref:`torrent-web-seeds`.

``PMTILES_TORRENT_PORT``
    Listening port. Default ``0`` (any free port).

Example:

.. code-block:: bash

  export PMTILES_TORRENT_PATH=/mnt/maps/store
  export PMTILES_TORRENT_CACHE_PIECES=32
  tileserver-gl --file /data/planet.pmtiles.torrent

.. _torrent-startup:

Startup and resume data
=======================

WebTorrent rebuilds its bitfield by hashing the entire store on every start. For a
72 GiB archive that measured **59.9 seconds**, and it scales with archive size. During
that window the torrent has not joined the swarm at all, which looks like "no peers".

Resume data removes it. The bitfield is persisted next to the data and handed back on
the next start, which measured **0.6 seconds** for the same archive. It is enabled
automatically whenever ``PMTILES_TORRENT_PATH`` is set.

A saved bitfield asserts that pieces are present without re-hashing them, so it is only
trusted when the data file still has the exact size and modification time it had when the
bitfield was written. Any write to the archive invalidates it, and the cost of being
wrong is one slow startup rather than corrupt tiles.

.. note::

   With startup down to well under a second, you will now see the swarm connect in real
   time - typically 10 to 20 seconds for tracker announce and handshake. That wait was
   always there; it used to be hidden behind the hashing.

Piece size
==========

Read amplification is ``pieceLength ÷ bytesWanted``. Torrent creation tools size pieces
for whole-file downloads, so a large archive commonly ends up at 16 MiB per piece - at
which point a cold 4 KB vector tile costs a 16 MiB download.

.. list-table::
   :header-rows: 1

   * - Piece length
     - Amplification for a 4 KB tile
     - Pieces in a 400 GiB archive
   * - 16 MiB
     - ~4000×
     - 25,600
   * - 4 MiB
     - ~1000×
     - 102,400
   * - 1 MiB
     - ~250×
     - 409,600

1-4 MiB is the usual sweet spot. Below that, the piece-hash list itself - which peers
must transfer before any tile can be served - starts to dominate.

Existing 16 MiB torrents work, and better than the raw numbers suggest. Because of
Hilbert ordering, one 16 MiB piece holds roughly 500 spatially adjacent tiles, so the
first tile in a new area pays for the whole piece and the next several hundred nearby
are free. It is a latency problem rather than a waste problem - provided the cache is
large enough to hold the piece long enough to collect the payoff, which is why
``PMTILES_TORRENT_CACHE_PIECES`` is counted in pieces.

.. _torrent-web-seeds:

Web seeds: the fix for slow cold tiles
======================================

If a torrent carries a BEP 19 ``url-list`` — an HTTP URL serving the same bytes — the
tile server uses it automatically, and it changes the performance picture completely.

A web seed is always available and usually far faster than a small swarm, so it removes
both problems at once: the wait for a peer at startup, and the bandwidth ceiling of a
handful of seeders. Verified with DHT and trackers **disabled entirely**, a tile was
served in 673 ms with no BitTorrent peers at all — every byte came over HTTP.

Nothing needs configuring on this side; the URL is in the torrent. What matters is that
whoever creates the torrent includes it:

.. code-block:: bash

  # mktorrent
  mktorrent -w https://maps.example.org/files/planet.pmtiles ... planet.pmtiles

  # pmtiles-swarm does it automatically when adding from a URL

The origin must support HTTP range requests (``Accept-Ranges: bytes``), which any static
file server and every CDN does.

The one setting worth raising is ``PMTILES_TORRENT_MAX_WEB_CONNS``. WebTorrent allows
only four simultaneous connections per web seed by default, which throttles exactly the
source you most want to lean on; the default here is 8.

If you publish archives over HTTP already, adding a web seed to their torrents is the
single largest improvement available to a torrent-backed tile server — larger than piece
size, and far larger than any client tuning.

Measured performance
====================

Against a live 71.93 GiB OpenMapTiles archive (4,604 pieces of 16 MiB), served from a
single seeder:

.. list-table::
   :header-rows: 1

   * - Operation
     - Time
   * - Startup with resume data
     - 0.6 s
   * - Startup without (full store re-hash)
     - 59.9 s
   * - Header read
     - 5.3 s
   * - Metadata read
     - 36.8 s
   * - TileJSON request
     - 20 ms
   * - Warm tile (pieces cached)
     - 14 ms
   * - Cold tile in a new region
     - ~31 s

The cold-tile figure is dominated by the single seeder's bandwidth, not by client
behaviour: it is two dependent piece fetches, a leaf directory then the tile data. More
peers is the single largest improvement available.

Seeding
=======

A tile server reading from a swarm is also a member of it. Every piece fetched to serve a
tile is then served to other peers, so a busy server organically becomes a partial
seeder for the regions its users look at.

Pointing ``PMTILES_TORRENT_PATH`` at a directory that already holds the complete archive
turns the tile server into a full seeder at no extra storage cost.

Limitations
===========

* **MBTiles cannot be served this way.** Random access to a SQLite file needs many
  dependent round trips and has no spatial locality to amortise them. Only PMTiles works.
* **BitTorrent v1 only.** WebTorrent does not implement BEP 52, so v2-only magnets
  (``btmh``) are not supported. Hybrid torrents work through their v1 half.
* **The first tile after startup blocks** until a peer is found, typically 10-20 seconds.

Troubleshooting
===============

``Unable to determine file type``
    A magnet has no usable extension and a ``.torrent`` file's is always ``.torrent``.
    Both are recognised, so this almost always means shell quoting: in ``cmd.exe`` the
    single quotes became part of the path. Use double quotes.

``timed out waiting for torrent metadata``
    Usually a magnet with no reachable peers. Confirm the trackers are reachable and that
    a seeder is running; try the ``.torrent`` file, which skips metadata exchange
    entirely. Raise ``PMTILES_TORRENT_READY_TIMEOUT_MS`` if the swarm is slow.

``short read from torrent: got N of M bytes``
    A piece fetch returned fewer bytes than requested. This is raised rather than served,
    because silently accepting it would place zero-padded data in the cache - which
    corrupts raster tiles subtly and makes gzipped vector tiles fail outright. If you see
    this, report it with the offset.

``ERR_INVALID_ARG_TYPE`` from ``Buffer.from`` when adding a magnet
    A dependency regression, not a configuration problem. ``uint8-util`` 2.3.0 rewrote
    ``arr2hex`` in a way that throws on the hex-string infohash that webtorrent passes it,
    breaking every magnet add. This repository pins ``uint8-util`` to ``2.2.5`` in the
    ``overrides`` block of ``package.json``. If you see this, run ``npm install`` to make
    the pin take effect.

No peers, and startup was instant
    Expected for the first 10-20 seconds after start. See :ref:`torrent-startup`.
