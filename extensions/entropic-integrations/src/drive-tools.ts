import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getGoogleAccessToken } from "./google.js";
import { runGws } from "./gws.js";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_API_BASE = "https://www.googleapis.com/upload/drive/v3";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(
  params: Record<string, unknown>,
  key: string,
  def?: number,
): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return def;
}

export function createDriveListTool(_api: OpenClawPluginApi) {
  return {
    name: "drive_list",
    label: "Drive List",
    description: "List files in Google Drive. Returns file names, IDs, and types.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Drive query filter (e.g., \"mimeType='application/pdf'\")." }),
      ),
      folderId: Type.Optional(
        Type.String({ description: "List files in a specific folder by ID." }),
      ),
      pageSize: Type.Optional(
        Type.Number({ description: "Max files to return (default 20, max 100)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = readString(params, "query");
      const folderId = readString(params, "folderId");
      const pageSize = Math.min(readNumber(params, "pageSize", 20) ?? 20, 100);

      const parts: string[] = [];
      if (query) parts.push(query);
      if (folderId) parts.push(`'${folderId}' in parents`);
      parts.push("trashed = false");

      const data = (await runGws(["drive", "files", "list"], {
        params: {
          pageSize,
          fields: "files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken",
          orderBy: "modifiedTime desc",
          q: parts.join(" and "),
        },
      })) as any;

      return jsonResult({
        files: (data.files || []).map((f: any) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
          size: f.size,
          webViewLink: f.webViewLink,
        })),
      });
    },
  };
}

export function createDriveSearchTool(_api: OpenClawPluginApi) {
  return {
    name: "drive_search",
    label: "Drive Search",
    description: "Search for files in Google Drive by name or content.",
    parameters: Type.Object({
      query: Type.String({ description: "Search text to find in file names or content." }),
      mimeType: Type.Optional(
        Type.String({ description: "Filter by MIME type (e.g., 'application/pdf')." }),
      ),
      pageSize: Type.Optional(Type.Number({ description: "Max results (default 20, max 100)." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const query = readString(params, "query");
      if (!query) throw new Error("query is required");
      const mimeType = readString(params, "mimeType");
      const pageSize = Math.min(readNumber(params, "pageSize", 20) ?? 20, 100);

      const parts = [`fullText contains '${query.replace(/'/g, "\\'")}'`, "trashed = false"];
      if (mimeType) parts.push(`mimeType = '${mimeType}'`);

      const data = (await runGws(["drive", "files", "list"], {
        params: {
          pageSize,
          fields: "files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken",
          q: parts.join(" and "),
        },
      })) as any;

      return jsonResult({
        files: (data.files || []).map((f: any) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
          size: f.size,
          webViewLink: f.webViewLink,
        })),
      });
    },
  };
}

const GOOGLE_DOCS_EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/png",
};

// drive_download and drive_upload use direct fetch — gws doesn't handle binary content well
export function createDriveDownloadTool(_api: OpenClawPluginApi) {
  return {
    name: "drive_download",
    label: "Drive Download",
    description: "Download or export a file from Google Drive. Returns the file content as text.",
    parameters: Type.Object({
      fileId: Type.String({ description: "The Drive file ID." }),
      mimeType: Type.Optional(
        Type.String({
          description:
            "Export MIME type for Google Docs (e.g., 'text/plain', 'application/pdf'). Auto-detected for native Google formats.",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const token = await getGoogleAccessToken("google_workspace");
      const fileId = readString(params, "fileId");
      if (!fileId) throw new Error("fileId is required");
      const requestedMime = readString(params, "mimeType");

      const meta = (await runGws(["drive", "files", "get"], {
        params: { fileId, fields: "id,name,mimeType,size" },
      })) as any;
      const isGoogleFormat = meta.mimeType?.startsWith("application/vnd.google-apps.");

      let content: string;
      if (isGoogleFormat) {
        const exportMime = requestedMime || GOOGLE_DOCS_EXPORT[meta.mimeType] || "text/plain";
        const res = await fetch(
          `${DRIVE_API_BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Drive export error ${res.status}: ${text}`);
        }
        content = await res.text();
      } else {
        const res = await fetch(`${DRIVE_API_BASE}/files/${fileId}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Drive download error ${res.status}: ${text}`);
        }
        content = await res.text();
      }

      return jsonResult({ fileId, name: meta.name, mimeType: meta.mimeType, content });
    },
  };
}

export function createDriveUploadTool(_api: OpenClawPluginApi) {
  return {
    name: "drive_upload",
    label: "Drive Upload",
    description: "Upload a file to Google Drive.",
    parameters: Type.Object({
      name: Type.String({ description: "File name." }),
      content: Type.String({ description: "File content (text)." }),
      mimeType: Type.Optional(Type.String({ description: "MIME type (default 'text/plain')." })),
      folderId: Type.Optional(Type.String({ description: "Parent folder ID." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const token = await getGoogleAccessToken("google_workspace");
      const name = readString(params, "name");
      if (!name) throw new Error("name is required");
      const content = readString(params, "content") ?? "";
      const mimeType = readString(params, "mimeType") || "text/plain";
      const folderId = readString(params, "folderId");

      const metadata: any = { name, mimeType };
      if (folderId) metadata.parents = [folderId];

      const boundary = "entropic_upload_boundary";
      const body = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${mimeType}`,
        "",
        content,
        `--${boundary}--`,
      ].join("\r\n");

      const res = await fetch(
        `${UPLOAD_API_BASE}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
        },
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Drive upload error ${res.status}: ${text}`);
      }

      const data = await res.json();
      return jsonResult({
        id: data.id,
        name: data.name,
        mimeType: data.mimeType,
        webViewLink: data.webViewLink,
      });
    },
  };
}

export function createDriveShareTool(_api: OpenClawPluginApi) {
  return {
    name: "drive_share",
    label: "Drive Share",
    description: "Share a Google Drive file or folder with someone.",
    parameters: Type.Object({
      fileId: Type.String({ description: "The Drive file or folder ID." }),
      email: Type.String({ description: "Email address to share with." }),
      role: Type.Optional(
        Type.String({
          description: "Permission role: 'reader', 'commenter', or 'writer' (default 'reader').",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const fileId = readString(params, "fileId");
      if (!fileId) throw new Error("fileId is required");
      const email = readString(params, "email");
      if (!email) throw new Error("email is required");
      const role = readString(params, "role") || "reader";

      const data = await runGws(["drive", "permissions", "create"], {
        params: { fileId },
        json: { role, type: "user", emailAddress: email },
      });

      return jsonResult(data);
    },
  };
}

export function createDriveCreateFolderTool(_api: OpenClawPluginApi) {
  return {
    name: "drive_create_folder",
    label: "Drive Create Folder",
    description: "Create a folder in Google Drive.",
    parameters: Type.Object({
      name: Type.String({ description: "Folder name." }),
      parentFolderId: Type.Optional(
        Type.String({ description: "Parent folder ID (creates in root if omitted)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const name = readString(params, "name");
      if (!name) throw new Error("name is required");
      const parentFolderId = readString(params, "parentFolderId");

      const metadata: any = {
        name,
        mimeType: "application/vnd.google-apps.folder",
      };
      if (parentFolderId) metadata.parents = [parentFolderId];

      const data = (await runGws(["drive", "files", "create"], {
        params: { fields: "id,name,mimeType,webViewLink" },
        json: metadata,
      })) as any;

      return jsonResult({
        id: data.id,
        name: data.name,
        mimeType: data.mimeType,
        webViewLink: data.webViewLink,
      });
    },
  };
}
