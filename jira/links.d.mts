// Types for links.mjs, which is plain ESM so server.js can import it too.
export interface PrLink {
  url: string;
  owner: string;
  repo: string;
  number: number;
  author: string | null;
  at: string | null;
}
export interface PreviewLink {
  kind: "preview" | "editor";
  url: string;
  // An editor link names the store and theme but not the storefront's domain.
  store: string;
  themeId: string;
  origin: string;
  path: string;
  author: string | null;
  at: string | null;
}
export interface TicketLinks {
  prs: PrLink[];
  previews: PreviewLink[];
}
export declare function findTicketLinks(detail: unknown): TicketLinks;
