import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildListFolderFilesRequest,
  buildListFolderFoldersRequest,
  buildFolderListItemAllFieldsRequest,
  buildFolderRenameRequest,
  buildRecycleFolderRequest,
  buildListFileVersionsRequest,
  buildRestoreFileVersionRequest,
  buildCheckOutRequest,
  buildCheckInRequest,
  buildUndoCheckOutRequest,
  buildUpdateFileMetadataRequest,
  parseFolderFilesResponse,
  parseFolderFoldersResponse,
  parseFileVersionsResponse,
  verboseResultCount,
  CHECK_IN_TYPE,
} from "./index.js";

const SITE = "https://contoso.sharepoint.com/sites/TestSite";
const API = `${SITE}/_api/web`;
const DIGEST = "0xDIGEST";

// A name containing an apostrophe must be escaped by DOUBLING it inside the
// single-quoted REST string literal — otherwise the literal terminates early
// and the request either 400s or (worse) addresses a different resource.
const APOSTROPHE_PATH = "/sites/TestSite/Shared Documents/O'Brien's Reports";
const APOSTROPHE_ESCAPED = "/sites/TestSite/Shared Documents/O''Brien''s Reports";
// Non-ASCII names are left as literal UTF-8 in the builder; fetch() performs
// the percent-encoding. Asserted explicitly so a future "helpful" encodeURI
// call that would double-encode them is caught.
const CHINESE_PATH = "/sites/TestSite/Shared Documents/測試資料夾";

// ---------------------------------------------------------------------------
// Feature 1 — list folder
// ---------------------------------------------------------------------------

test("buildListFolderFilesRequest produces the exact documented URL", () => {
  const call = buildListFolderFilesRequest(SITE, "/sites/TestSite/Shared Documents", 200);
  assert.equal(
    call.url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='/sites/TestSite/Shared Documents')/Files` +
      `?$select=Name,ServerRelativeUrl,Length,TimeLastModified,TimeCreated&$top=200`
  );
  assert.equal(call.method, "GET");
  assert.equal(call.headers.Accept, "application/json;odata=verbose");
  // A GET needs no digest, and must never carry one.
  assert.equal(call.headers["X-RequestDigest"], undefined);
});

test("buildListFolderFilesRequest doubles apostrophes in the folder path", () => {
  const call = buildListFolderFilesRequest(SITE, APOSTROPHE_PATH, 50);
  assert.equal(
    call.url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='${APOSTROPHE_ESCAPED}')/Files` +
      `?$select=Name,ServerRelativeUrl,Length,TimeLastModified,TimeCreated&$top=50`
  );
});

test("buildListFolderFilesRequest passes a Chinese folder name through unmodified", () => {
  const call = buildListFolderFilesRequest(SITE, CHINESE_PATH, 200);
  assert.equal(
    call.url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='${CHINESE_PATH}')/Files` +
      `?$select=Name,ServerRelativeUrl,Length,TimeLastModified,TimeCreated&$top=200`
  );
  assert.ok(call.url.includes("測試資料夾"));
});

test("buildListFolderFoldersRequest produces the exact documented URL, apostrophe and Chinese variants", () => {
  assert.equal(
    buildListFolderFoldersRequest(SITE, "/sites/TestSite/Shared Documents", 200).url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='/sites/TestSite/Shared Documents')/Folders` +
      `?$select=Name,ServerRelativeUrl,ItemCount&$top=200`
  );
  assert.equal(
    buildListFolderFoldersRequest(SITE, APOSTROPHE_PATH, 1000).url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='${APOSTROPHE_ESCAPED}')/Folders` +
      `?$select=Name,ServerRelativeUrl,ItemCount&$top=1000`
  );
  assert.equal(
    buildListFolderFoldersRequest(SITE, CHINESE_PATH, 200).url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='${CHINESE_PATH}')/Folders` +
      `?$select=Name,ServerRelativeUrl,ItemCount&$top=200`
  );
});

test("parseFolderFilesResponse maps the verbose OData d.results shape", () => {
  const files = parseFolderFilesResponse({
    d: {
      results: [
        {
          Name: "報表.xlsx",
          ServerRelativeUrl: "/sites/TestSite/Shared Documents/報表.xlsx",
          Length: "20480",
          TimeLastModified: "2026-08-01T10:00:00Z",
          TimeCreated: "2026-07-01T10:00:00Z",
        },
      ],
    },
  });
  assert.deepEqual(files, [
    {
      name: "報表.xlsx",
      serverRelativeUrl: "/sites/TestSite/Shared Documents/報表.xlsx",
      size: 20480,
      modified: "2026-08-01T10:00:00Z",
      created: "2026-07-01T10:00:00Z",
    },
  ]);
});

test("parseFolderFilesResponse returns an empty array for an empty or malformed body", () => {
  assert.deepEqual(parseFolderFilesResponse({ d: { results: [] } }), []);
  assert.deepEqual(parseFolderFilesResponse({}), []);
  assert.deepEqual(parseFolderFilesResponse(null), []);
});

test("parseFolderFoldersResponse filters out the SharePoint system 'Forms' folder", () => {
  const folders = parseFolderFoldersResponse({
    d: {
      results: [
        { Name: "Forms", ServerRelativeUrl: "/sites/TestSite/Shared Documents/Forms", ItemCount: 3 },
        { Name: "2026", ServerRelativeUrl: "/sites/TestSite/Shared Documents/2026", ItemCount: 12 },
      ],
    },
  });
  assert.deepEqual(folders, [
    { name: "2026", serverRelativeUrl: "/sites/TestSite/Shared Documents/2026", itemCount: 12 },
  ]);
});

test("verboseResultCount counts the raw page, before 'Forms' filtering, so truncation is judged correctly", () => {
  const body = {
    d: {
      results: [
        { Name: "Forms", ServerRelativeUrl: "/x/Forms", ItemCount: 1 },
        { Name: "A", ServerRelativeUrl: "/x/A", ItemCount: 1 },
      ],
    },
  };
  assert.equal(verboseResultCount(body), 2);
  assert.equal(parseFolderFoldersResponse(body).length, 1);
});

// ---------------------------------------------------------------------------
// Feature 2 — rename folder
// ---------------------------------------------------------------------------

test("buildFolderListItemAllFieldsRequest targets the folder's ListItem via the ResourcePath form", () => {
  assert.equal(
    buildFolderListItemAllFieldsRequest(SITE, APOSTROPHE_PATH).url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='${APOSTROPHE_ESCAPED}')/ListItemAllFields`
  );
  assert.equal(
    buildFolderListItemAllFieldsRequest(SITE, CHINESE_PATH).url,
    `${API}/GetFolderByServerRelativePath(decodedUrl='${CHINESE_PATH}')/ListItemAllFields`
  );
});

test("buildFolderRenameRequest MERGEs Title+FileLeafRef with the runtime odata.type", () => {
  const call = buildFolderRenameRequest(SITE, CHINESE_PATH, "SP.Data.Shared_x0020_DocumentsItem", '"3"', "新資料夾", DIGEST);
  assert.equal(call.url, `${API}/GetFolderByServerRelativePath(decodedUrl='${CHINESE_PATH}')/ListItemAllFields`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["X-HTTP-Method"], "MERGE");
  assert.equal(call.headers["IF-MATCH"], '"3"');
  assert.equal(call.headers["X-RequestDigest"], DIGEST);
  assert.deepEqual(JSON.parse(call.body as string), {
    __metadata: { type: "SP.Data.Shared_x0020_DocumentsItem" },
    Title: "新資料夾",
    FileLeafRef: "新資料夾",
  });
});

// ---------------------------------------------------------------------------
// Feature 3 — recycle folder
// ---------------------------------------------------------------------------

test("buildRecycleFolderRequest posts to the folder's recycle endpoint with a digest", () => {
  const call = buildRecycleFolderRequest(SITE, APOSTROPHE_PATH, DIGEST);
  assert.equal(call.url, `${API}/GetFolderByServerRelativePath(decodedUrl='${APOSTROPHE_ESCAPED}')/recycle`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers["X-RequestDigest"], DIGEST);
  assert.equal(buildRecycleFolderRequest(SITE, CHINESE_PATH, DIGEST).url, `${API}/GetFolderByServerRelativePath(decodedUrl='${CHINESE_PATH}')/recycle`);
});

// ---------------------------------------------------------------------------
// Feature 4 — versions
// ---------------------------------------------------------------------------

test("buildListFileVersionsRequest targets /versions off GetFileByServerRelativeUrl", () => {
  assert.equal(
    buildListFileVersionsRequest(SITE, "/sites/TestSite/Shared Documents/O'Brien's Report.docx").url,
    `${API}/GetFileByServerRelativeUrl('/sites/TestSite/Shared Documents/O''Brien''s Report.docx')/versions`
  );
  assert.equal(
    buildListFileVersionsRequest(SITE, "/sites/TestSite/Shared Documents/測試報表.docx").url,
    `${API}/GetFileByServerRelativeUrl('/sites/TestSite/Shared Documents/測試報表.docx')/versions`
  );
});

test("buildRestoreFileVersionRequest escapes both the path and the version label", () => {
  const call = buildRestoreFileVersionRequest(SITE, "/sites/TestSite/Shared Documents/測試報表.docx", "1.2", DIGEST);
  assert.equal(
    call.url,
    `${API}/GetFileByServerRelativeUrl('/sites/TestSite/Shared Documents/測試報表.docx')/versions/restorebylabel(versionlabel='1.2')`
  );
  assert.equal(call.method, "POST");
  assert.equal(call.headers["X-RequestDigest"], DIGEST);
  // A label is attacker-influenced input like any other literal; verify it
  // cannot break out of the quoted literal.
  assert.equal(
    buildRestoreFileVersionRequest(SITE, "/a/b.docx", "1'2", DIGEST).url,
    `${API}/GetFileByServerRelativeUrl('/a/b.docx')/versions/restorebylabel(versionlabel='1''2')`
  );
});

test("parseFileVersionsResponse returns the display name only and never an email or login name", () => {
  const versions = parseFileVersionsResponse({
    d: {
      results: [
        {
          VersionLabel: "1.0",
          ID: 512,
          Created: "2026-07-01T09:00:00Z",
          CreatedBy: { Title: "Test User", Email: "user@example.com", LoginName: "i:0#.f|membership|user@example.com" },
          Size: "1024",
          IsCurrentVersion: false,
          CheckInComment: "first draft",
        },
        // Without $expand, CreatedBy comes back as a deferred navigation stub.
        { VersionLabel: "2.0", ID: 513, Created: null, CreatedBy: { __deferred: {} }, Size: "2048", IsCurrentVersion: true, CheckInComment: "" },
      ],
    },
  });
  assert.deepEqual(versions[0], {
    versionLabel: "1.0",
    id: 512,
    created: "2026-07-01T09:00:00Z",
    createdBy: "Test User",
    size: 1024,
    isCurrentVersion: false,
    checkInComment: "first draft",
  });
  assert.equal(versions[1].createdBy, null);
  assert.equal(versions[1].checkInComment, null);
  const serialized = JSON.stringify(versions);
  assert.ok(!serialized.includes("user@example.com"), "version payload must not leak an email address");
  assert.ok(!serialized.includes("membership|"), "version payload must not leak a login name");
});

// ---------------------------------------------------------------------------
// Feature 5 — check-out / check-in
// ---------------------------------------------------------------------------

test("buildCheckOutRequest / buildUndoCheckOutRequest produce the documented method-call URLs", () => {
  assert.equal(
    buildCheckOutRequest(SITE, "/sites/TestSite/Shared Documents/O'Brien's Report.docx", DIGEST).url,
    `${API}/GetFileByServerRelativeUrl('/sites/TestSite/Shared Documents/O''Brien''s Report.docx')/CheckOut()`
  );
  assert.equal(
    buildUndoCheckOutRequest(SITE, "/sites/TestSite/Shared Documents/測試報表.docx", DIGEST).url,
    `${API}/GetFileByServerRelativeUrl('/sites/TestSite/Shared Documents/測試報表.docx')/UndoCheckOut()`
  );
});

test("buildCheckInRequest embeds the escaped comment and the numeric check-in type", () => {
  assert.equal(CHECK_IN_TYPE.minor, 0);
  assert.equal(CHECK_IN_TYPE.major, 1);
  assert.equal(CHECK_IN_TYPE.overwrite, 2);

  assert.equal(
    buildCheckInRequest(SITE, "/sites/TestSite/Shared Documents/測試報表.docx", "已完成校對", CHECK_IN_TYPE.major, DIGEST).url,
    `${API}/GetFileByServerRelativeUrl('/sites/TestSite/Shared Documents/測試報表.docx')/CheckIn(comment='已完成校對',checkintype=1)`
  );
  // The comment is user text and the most likely place an apostrophe appears.
  assert.equal(
    buildCheckInRequest(SITE, "/a/b.docx", "O'Brien's edits", CHECK_IN_TYPE.minor, DIGEST).url,
    `${API}/GetFileByServerRelativeUrl('/a/b.docx')/CheckIn(comment='O''Brien''s edits',checkintype=0)`
  );
});

// ---------------------------------------------------------------------------
// Feature 6 — update file metadata
// ---------------------------------------------------------------------------

test("buildUpdateFileMetadataRequest MERGEs the supplied fields alongside __metadata", () => {
  const call = buildUpdateFileMetadataRequest(
    SITE,
    "/sites/TestSite/Shared Documents/O'Brien's Report.docx",
    "SP.Data.Shared_x0020_DocumentsItem",
    "*",
    { Title: "季報 Q1", ReviewScore: 5, Notes: null },
    DIGEST
  );
  assert.equal(
    call.url,
    `${API}/GetFileByServerRelativeUrl('/sites/TestSite/Shared Documents/O''Brien''s Report.docx')/ListItemAllFields`
  );
  assert.equal(call.headers["X-HTTP-Method"], "MERGE");
  assert.equal(call.headers["IF-MATCH"], "*");
  assert.deepEqual(JSON.parse(call.body as string), {
    __metadata: { type: "SP.Data.Shared_x0020_DocumentsItem" },
    Title: "季報 Q1",
    ReviewScore: 5,
    Notes: null,
  });
});
