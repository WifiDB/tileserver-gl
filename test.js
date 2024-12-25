import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

function testPBF(){
    const pbf = new Pbf();
    pbf.writeTag(1);
    pbf.writeMessage(()=>{
        pbf.writeTag(1)
        pbf.writeString('test string');
    })

     return new VectorTile(pbf.finish());

}
const tile = testPBF();
console.log(tile)