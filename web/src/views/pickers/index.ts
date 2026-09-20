// Every control that had to be built because the app's WebView would not run
// the browser's own (docs/IMPROVEMENTS.md §2).
//
// Views import from here and never reach for a raw <input> or <select>, so the
// next thing that turns out to be broken on a device is fixed once.

export { Choose, ChooseMany, type Choice } from "./Choose";
export { Stars } from "./Stars";
export { MapPick } from "./MapPick";
export { Amount } from "./Amount";
export { Count } from "./Count";
