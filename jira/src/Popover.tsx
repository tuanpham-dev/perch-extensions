// A floating card that escapes the tab it was opened from.
//
// Every popover here is `position: fixed` with coordinates measured from its
// anchor, which ought to be enough to float over the window. It is not: core
// lays the editor area out in `.split-content-host`, which is itself
// positioned with a z-index, and that makes a stacking context. Inside one,
// a child's z-index only ranks it against its siblings - the whole context
// sits at ITS z-index whatever the child asks for - so the popover rendered
// under the right sidebar, which is painted later, and the file tree showed
// straight through it.
//
// Rendering into `document.body` puts the card back in the page's own
// stacking order, where `z-index` means what it says. The element is
// unchanged, so the ref, the outside-click check and the position hook all
// carry on working; React still propagates its events to the component that
// opened it, portal or not.
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export default function Popover({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
