// The settings resolvers, which turn stored values into what the editor is
// actually configured with. Only the "auto" modes have logic worth pinning:
// they read a *second* setting, so a wrong answer there is a setting that
// silently does nothing.
import { strict as assert } from "node:assert";
import { test } from "node:test";

const src = await import("./settings.ts");
const { setSettingsApi, clearSettingsApi, lineNumbersMode, lineNumbersOption, vimEnabled, parseChordList, formatChordList, chordOwner, setChordOwner } =
  src;

// Stands in for the host's settings API: a plain bag of values, plus the
// onDidChange the module subscribes to at wiring time.
function withSettings(values: Record<string, unknown>): void {
  clearSettingsApi();
  setSettingsApi({ get: (key: string) => values[key], onDidChange: () => () => {} });
}

test("lineNumbers falls back to auto for a missing or unknown value", () => {
  withSettings({});
  assert.equal(lineNumbersMode(), "auto");
  withSettings({ "textEditor.lineNumbers": "sideways" });
  assert.equal(lineNumbersMode(), "auto");
  // The pre-2.3.0 stored shape: the key simply isn't there yet.
  withSettings({ "textEditor.vim": true });
  assert.equal(lineNumbersMode(), "auto");
});

test("auto follows the vim setting", () => {
  withSettings({ "textEditor.lineNumbers": "auto", "textEditor.vim": true });
  assert.equal(lineNumbersOption(), "relative");
  withSettings({ "textEditor.lineNumbers": "auto", "textEditor.vim": false });
  assert.equal(lineNumbersOption(), "on");
  // vim unset is vim off, so an untouched install keeps absolute numbers.
  withSettings({});
  assert.equal(vimEnabled(), false);
  assert.equal(lineNumbersOption(), "on");
});

test("an explicit mode wins over vim in both directions", () => {
  for (const vim of [true, false]) {
    withSettings({ "textEditor.lineNumbers": "on", "textEditor.vim": vim });
    assert.equal(lineNumbersOption(), "on");
    withSettings({ "textEditor.lineNumbers": "relative", "textEditor.vim": vim });
    assert.equal(lineNumbersOption(), "relative");
    withSettings({ "textEditor.lineNumbers": "off", "textEditor.vim": vim });
    assert.equal(lineNumbersOption(), "off");
  }
});

test("every resolved value is one Monaco accepts", () => {
  const allowed = new Set(["on", "relative", "off"]);
  for (const mode of ["auto", "on", "relative", "off", undefined, "nonsense"]) {
    for (const vim of [true, false]) {
      withSettings({ "textEditor.lineNumbers": mode, "textEditor.vim": vim });
      assert.ok(allowed.has(lineNumbersOption()), `${String(mode)}/${vim} -> ${lineNumbersOption()}`);
    }
  }
});

test("chord lists accept the spellings a user is likely to type", () => {
  assert.deepEqual([...parseChordList("c v, A")], ["Ctrl-c", "Ctrl-v", "Ctrl-a"]);
  assert.deepEqual([...parseChordList("ctrl+c Ctrl-X <C-z>")], ["Ctrl-c", "Ctrl-x", "Ctrl-z"]);
  assert.deepEqual([...parseChordList("ctrl+shift+z <C-S-y>")], ["Shift-Ctrl-z", "Shift-Ctrl-y"]);
  assert.deepEqual([...parseChordList("ctrl+-")], ["Ctrl--"]);
});

test("chord lists drop what isn't a single Ctrl chord", () => {
  assert.deepEqual([...parseChordList("alt+c meta+v esc ctrl+tab")], []);
  assert.deepEqual([...parseChordList("")], []);
  assert.deepEqual([...parseChordList(undefined)], []);
  assert.deepEqual([...parseChordList(["c"])], []);
});

test("a formatted chord list parses back to itself", () => {
  const keys = parseChordList("c <C-v> ctrl+shift+z");
  assert.equal(formatChordList(keys), "c v shift+z");
  assert.deepEqual(parseChordList(formatChordList(keys)), keys);
});

test("a chord's owner follows the lists, and the editor list wins a tie", () => {
  withSettings({ "textEditor.vimEditorKeys": "c v", "textEditor.vimKeys": "v d" });
  assert.equal(chordOwner("Ctrl-c"), "editor");
  assert.equal(chordOwner("Ctrl-v"), "editor");
  assert.equal(chordOwner("Ctrl-d"), "vim");
  assert.equal(chordOwner("Ctrl-a"), null);
});

test("setting an owner moves the chord between the lists", () => {
  const values: Record<string, unknown> = { "textEditor.vimEditorKeys": "c", "textEditor.vimKeys": "ctrl+v, <C-d>" };
  clearSettingsApi();
  setSettingsApi({
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => {
      values[key] = value;
    },
    onDidChange: () => () => {},
  });
  setChordOwner("Ctrl-v", "editor");
  assert.equal(values["textEditor.vimEditorKeys"], "c v");
  assert.equal(values["textEditor.vimKeys"], "d");
  assert.equal(chordOwner("Ctrl-v"), "editor");
  // The untouched list keeps its hand-written spelling.
  setChordOwner("Ctrl-a", "vim");
  assert.equal(values["textEditor.vimKeys"], "d a");
  assert.equal(values["textEditor.vimEditorKeys"], "c v");
});
