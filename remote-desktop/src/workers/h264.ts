// Software H.264 decoder worker: tinyh264 (h264bsd compiled to WebAssembly,
// embedded in its JS). The main thread posts {type: "decode", renderStateId,
// data, offset, length} per NAL unit and receives {type: "pictureReady",
// width, height, data} with an I420 picture; {type: "release"} drops a
// decoder. Built to dist/workers/h264.js and loaded by URL, so its 180 KB
// never touches client.js.
import { init } from "tinyh264";

init();
