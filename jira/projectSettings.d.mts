// Types for projectSettings.mjs, which the client imports as well as the
// server. Kept beside it so the two cannot drift apart unnoticed.
export type ProjectOverrides = Record<string, unknown>;
export const GLOBAL_ONLY: ReadonlySet<string>;
export function isOverridable(key: unknown): boolean;
export function parseProjectSettings(raw: unknown): { projects: Record<string, ProjectOverrides>; malformed: boolean };
export function overridesFor(raw: unknown, projectKey: string | null | undefined): ProjectOverrides;
export function settingsForProject<T extends Record<string, unknown>>(settings: T, projectKey: string | null | undefined): T;
export function setProjectOverride(raw: unknown, projectKey: string, setting: string, value: unknown): string;
export function removeProjectOverrides(raw: unknown, projectKey: string): string;
export function serializeProjectSettings(projects: Record<string, ProjectOverrides>): string;
