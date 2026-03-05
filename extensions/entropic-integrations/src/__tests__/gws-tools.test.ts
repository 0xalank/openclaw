import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mocks ----

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../google.js", () => ({
  getGoogleAccessToken: vi.fn().mockResolvedValue("mock-token-123"),
}));

// Stub fetch for drive_download / drive_upload
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const execFileMock = vi.mocked(execFile);

// ---- Helpers ----

/** Configure execFileMock to resolve with JSON */
function gwsReturns(json: unknown) {
  execFileMock.mockImplementation(((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(null, JSON.stringify(json), "");
  }) as any);
}

/** Configure execFileMock to reject with an error */
function gwsFails(stderr: string) {
  execFileMock.mockImplementation(((_cmd: any, _args: any, _opts: any, cb: any) => {
    const err = new Error("gws failed") as ExecFileException;
    err.code = "1";
    cb(err, "", stderr);
  }) as any);
}

/** Extract the args passed to execFile */
function lastGwsArgs(): string[] {
  const call = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
  return call[1] as string[];
}

/** Extract env from last execFile call */
function lastGwsEnv(): Record<string, string> {
  const call = execFileMock.mock.calls[execFileMock.mock.calls.length - 1];
  return (call[2] as { env: Record<string, string> }).env;
}

// ---- Tests ----

describe("runGws helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes GOOGLE_WORKSPACE_CLI_TOKEN env var", async () => {
    gwsReturns({ ok: true });
    const { runGws } = await import("../gws.js");
    await runGws(["drive", "files", "list"]);
    expect(lastGwsEnv().GOOGLE_WORKSPACE_CLI_TOKEN).toBe("mock-token-123");
  });

  it("builds correct args with params and json", async () => {
    gwsReturns({ ok: true });
    const { runGws } = await import("../gws.js");
    await runGws(["drive", "files", "list"], {
      params: { pageSize: 10, q: "trashed = false" },
      json: { test: true },
    });
    const args = lastGwsArgs();
    expect(args[0]).toBe("drive");
    expect(args[1]).toBe("files");
    expect(args[2]).toBe("list");
    expect(args[3]).toBe("--params");
    expect(JSON.parse(args[4])).toEqual({ pageSize: 10, q: "trashed = false" });
    expect(args[5]).toBe("--json");
    expect(JSON.parse(args[6])).toEqual({ test: true });
  });

  it("parses JSON stdout", async () => {
    gwsReturns({ files: [{ id: "1", name: "test.txt" }] });
    const { runGws } = await import("../gws.js");
    const result = await runGws(["drive", "files", "list"]);
    expect(result).toEqual({ files: [{ id: "1", name: "test.txt" }] });
  });

  it("falls back to raw string for non-JSON output", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "plain text response\n", "");
      },
    );
    const { runGws } = await import("../gws.js");
    const result = await runGws(["test"]);
    expect(result).toBe("plain text response");
  });

  it("rejects with stderr on error", async () => {
    gwsFails("Permission denied");
    const { runGws } = await import("../gws.js");
    await expect(runGws(["drive", "files", "list"])).rejects.toThrow("Permission denied");
  });
});

describe("drive tools", () => {
  const api = {} as any;
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("drive_list", () => {
    it("builds correct query with folderId", async () => {
      gwsReturns({ files: [] });
      const { createDriveListTool } = await import("../drive-tools.js");
      const tool = createDriveListTool(api);
      await tool.execute("1", { folderId: "folder123", pageSize: 5 });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.q).toContain("'folder123' in parents");
      expect(params.q).toContain("trashed = false");
      expect(params.pageSize).toBe(5);
    });

    it("caps pageSize at 100", async () => {
      gwsReturns({ files: [] });
      const { createDriveListTool } = await import("../drive-tools.js");
      const tool = createDriveListTool(api);
      await tool.execute("1", { pageSize: 500 });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.pageSize).toBe(100);
    });

    it("maps response files correctly", async () => {
      gwsReturns({
        files: [
          {
            id: "1",
            name: "doc.txt",
            mimeType: "text/plain",
            modifiedTime: "2026-01-01",
            size: "100",
            webViewLink: "https://...",
          },
        ],
      });
      const { createDriveListTool } = await import("../drive-tools.js");
      const tool = createDriveListTool(api);
      const result = await tool.execute("1", {});
      expect(result.details).toEqual({
        files: [
          {
            id: "1",
            name: "doc.txt",
            mimeType: "text/plain",
            modifiedTime: "2026-01-01",
            size: "100",
            webViewLink: "https://...",
          },
        ],
      });
    });
  });

  describe("drive_search", () => {
    it("escapes single quotes in query", async () => {
      gwsReturns({ files: [] });
      const { createDriveSearchTool } = await import("../drive-tools.js");
      const tool = createDriveSearchTool(api);
      await tool.execute("1", { query: "it's a test" });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.q).toContain("it\\'s a test");
    });

    it("requires query", async () => {
      const { createDriveSearchTool } = await import("../drive-tools.js");
      const tool = createDriveSearchTool(api);
      await expect(tool.execute("1", {})).rejects.toThrow("query is required");
    });
  });

  describe("drive_share", () => {
    it("passes fileId in params and email/role in json", async () => {
      gwsReturns({ id: "perm1" });
      const { createDriveShareTool } = await import("../drive-tools.js");
      const tool = createDriveShareTool(api);
      await tool.execute("1", { fileId: "file1", email: "alice@example.com", role: "writer" });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      const json = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(params.fileId).toBe("file1");
      expect(json.emailAddress).toBe("alice@example.com");
      expect(json.role).toBe("writer");
      expect(json.type).toBe("user");
    });

    it("defaults role to reader", async () => {
      gwsReturns({ id: "perm1" });
      const { createDriveShareTool } = await import("../drive-tools.js");
      const tool = createDriveShareTool(api);
      await tool.execute("1", { fileId: "file1", email: "bob@example.com" });
      const args = lastGwsArgs();
      const json = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(json.role).toBe("reader");
    });
  });

  describe("drive_create_folder", () => {
    it("sets mimeType to folder", async () => {
      gwsReturns({
        id: "folder1",
        name: "Test",
        mimeType: "application/vnd.google-apps.folder",
        webViewLink: "https://...",
      });
      const { createDriveCreateFolderTool } = await import("../drive-tools.js");
      const tool = createDriveCreateFolderTool(api);
      await tool.execute("1", { name: "Test Folder" });
      const args = lastGwsArgs();
      const json = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(json.mimeType).toBe("application/vnd.google-apps.folder");
      expect(json.name).toBe("Test Folder");
    });
  });
});

describe("sheets tools", () => {
  const api = {} as any;
  beforeEach(() => vi.clearAllMocks());

  describe("sheets_read", () => {
    it("passes spreadsheetId and range as params", async () => {
      gwsReturns({ range: "Sheet1!A1:B2", values: [[1, 2]], majorDimension: "ROWS" });
      const { createSheetsReadTool } = await import("../sheets-tools.js");
      const tool = createSheetsReadTool(api);
      await tool.execute("1", { spreadsheetId: "abc", range: "Sheet1!A1:B2" });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.spreadsheetId).toBe("abc");
      expect(params.range).toBe("Sheet1!A1:B2");
    });
  });

  describe("sheets_write", () => {
    it("uses USER_ENTERED valueInputOption", async () => {
      gwsReturns({ updatedRange: "A1:B2", updatedRows: 1, updatedColumns: 2, updatedCells: 2 });
      const { createSheetsWriteTool } = await import("../sheets-tools.js");
      const tool = createSheetsWriteTool(api);
      await tool.execute("1", { spreadsheetId: "abc", range: "A1", values: [[1, 2]] });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.valueInputOption).toBe("USER_ENTERED");
    });
  });

  describe("sheets_append", () => {
    it("uses INSERT_ROWS insertDataOption", async () => {
      gwsReturns({ updates: { updatedRange: "A3:B4", updatedRows: 1 } });
      const { createSheetsAppendTool } = await import("../sheets-tools.js");
      const tool = createSheetsAppendTool(api);
      await tool.execute("1", { spreadsheetId: "abc", range: "Sheet1!A1", values: [["a", "b"]] });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.insertDataOption).toBe("INSERT_ROWS");
    });
  });
});

describe("docs tools", () => {
  const api = {} as any;
  beforeEach(() => vi.clearAllMocks());

  describe("docs_read", () => {
    it("extracts text from doc body", async () => {
      gwsReturns({
        documentId: "doc1",
        title: "Test Doc",
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: "Hello " } }, { textRun: { content: "World" } }],
              },
            },
          ],
        },
      });
      const { createDocsReadTool } = await import("../docs-tools.js");
      const tool = createDocsReadTool(api);
      const result = await tool.execute("1", { documentId: "doc1" });
      expect(result.details).toEqual({
        documentId: "doc1",
        title: "Test Doc",
        content: "Hello World",
      });
    });
  });

  describe("docs_edit", () => {
    it("builds replaceAllText request", async () => {
      gwsReturns({ documentId: "doc1", replies: [] });
      const { createDocsEditTool } = await import("../docs-tools.js");
      const tool = createDocsEditTool(api);
      await tool.execute("1", { documentId: "doc1", replaceText: { find: "old", replace: "new" } });
      const args = lastGwsArgs();
      const json = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(json.requests[0].replaceAllText.containsText.text).toBe("old");
      expect(json.requests[0].replaceAllText.replaceText).toBe("new");
    });

    it("requires at least one edit operation", async () => {
      const { createDocsEditTool } = await import("../docs-tools.js");
      const tool = createDocsEditTool(api);
      await expect(tool.execute("1", { documentId: "doc1" })).rejects.toThrow(
        "Either insertText or replaceText",
      );
    });
  });

  describe("docs_create", () => {
    it("passes title in json body", async () => {
      gwsReturns({ documentId: "doc2", title: "New Doc" });
      const { createDocsCreateTool } = await import("../docs-tools.js");
      const tool = createDocsCreateTool(api);
      await tool.execute("1", { title: "New Doc" });
      const args = lastGwsArgs();
      const json = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(json.title).toBe("New Doc");
    });
  });
});

describe("contacts tools", () => {
  const api = {} as any;
  beforeEach(() => vi.clearAllMocks());

  describe("contacts_list", () => {
    it("sets resourceName to people/me", async () => {
      gwsReturns({ connections: [], totalPeople: 0 });
      const { createContactsListTool } = await import("../contacts-tools.js");
      const tool = createContactsListTool(api);
      await tool.execute("1", {});
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.resourceName).toBe("people/me");
      expect(params.personFields).toBe("names,emailAddresses,phoneNumbers,organizations");
    });
  });

  describe("contacts_search", () => {
    it("passes query and readMask", async () => {
      gwsReturns({ results: [] });
      const { createContactsSearchTool } = await import("../contacts-tools.js");
      const tool = createContactsSearchTool(api);
      await tool.execute("1", { query: "John" });
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.query).toBe("John");
      expect(params.readMask).toBe("names,emailAddresses,phoneNumbers,organizations");
    });
  });
});

describe("tasks tools", () => {
  const api = {} as any;
  beforeEach(() => vi.clearAllMocks());

  describe("tasks_list", () => {
    it("defaults taskListId to @default", async () => {
      gwsReturns({ items: [] });
      const { createTasksListTool } = await import("../tasks-tools.js");
      const tool = createTasksListTool(api);
      await tool.execute("1", {});
      const args = lastGwsArgs();
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      expect(params.tasklist).toBe("@default");
    });
  });

  describe("tasks_create", () => {
    it("sends title/notes/due in json body", async () => {
      gwsReturns({
        id: "t1",
        title: "Buy groceries",
        status: "needsAction",
        due: "2026-03-15T00:00:00Z",
      });
      const { createTasksCreateTool } = await import("../tasks-tools.js");
      const tool = createTasksCreateTool(api);
      await tool.execute("1", {
        title: "Buy groceries",
        notes: "Milk, bread",
        due: "2026-03-15T00:00:00Z",
      });
      const args = lastGwsArgs();
      const json = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(json.title).toBe("Buy groceries");
      expect(json.notes).toBe("Milk, bread");
      expect(json.due).toBe("2026-03-15T00:00:00Z");
    });
  });

  describe("tasks_update", () => {
    it("only includes provided fields in patch", async () => {
      gwsReturns({ id: "t1", title: "Updated", status: "completed" });
      const { createTasksUpdateTool } = await import("../tasks-tools.js");
      const tool = createTasksUpdateTool(api);
      await tool.execute("1", { taskId: "t1", status: "completed" });
      const args = lastGwsArgs();
      const json = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(json.status).toBe("completed");
      expect(json.title).toBeUndefined();
      expect(json.notes).toBeUndefined();
    });
  });
});
