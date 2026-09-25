// A ticket key that is a real link to the ticket in Jira. A real <a href>
// rather than a button, for the same reason the table's key is one: ctrl-click
// for a new tab, middle-click, "Copy link address" are all the browser's, and
// none of it is ours to reimplement.
//
// It stops its click from bubbling, so a key on a card can be followed
// without the card underneath taking the click as "focus me". A ticket the
// batch has no URL for (none should exist, but the doc is data) renders as
// the plain span it was.
import type { MouseEvent } from "react";

export default function KeyLink({ issueKey, url, className }: { issueKey: string; url: string | undefined; className?: string }) {
  const classes = className ? `jira-key ${className}` : "jira-key";
  if (!url) return <span className={classes}>{issueKey}</span>;
  return (
    <a
      className={`${classes} jira-keyopen`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${issueKey} in Jira`}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      {issueKey}
    </a>
  );
}
