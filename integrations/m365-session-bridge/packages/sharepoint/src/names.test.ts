import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLeafName } from "./index.js";

test("validateLeafName accepts ordinary names, including non-ASCII", () => {
  for (const name of ["Documents", "2026", "Q1 Report", "測試用假資料", "a.b.c", "file-name_1"]) {
    assert.equal(validateLeafName(name).ok, true, `expected '${name}' to be accepted`);
  }
});

test("validateLeafName rejects characters SharePoint forbids", () => {
  for (const name of ['a"b', "a*b", "a:b", "a<b", "a>b", "a?b", "a/b", "a\\b", "a|b"]) {
    assert.equal(validateLeafName(name).ok, false, `expected '${name}' to be rejected`);
  }
});

test("validateLeafName rejects traversal-flavoured and empty names", () => {
  for (const name of ["", "   ", ".", "..", " leading", "trailing ", "endsWithDot."]) {
    assert.equal(validateLeafName(name).ok, false, `expected '${JSON.stringify(name)}' to be rejected`);
  }
});

test("validateLeafName rejects reserved and Office lock-file names", () => {
  for (const name of ["CON", "PRN", "AUX", "NUL", "desktop.ini", ".lock", "~$doc"]) {
    assert.equal(validateLeafName(name).ok, false, `expected '${name}' to be rejected`);
  }
});
