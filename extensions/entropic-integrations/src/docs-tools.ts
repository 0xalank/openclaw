import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runGws } from "./gws.js";

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

function extractText(body: any): string {
  if (!body?.content) return "";
  const parts: string[] = [];
  for (const element of body.content) {
    if (element.paragraph?.elements) {
      for (const el of element.paragraph.elements) {
        if (el.textRun?.content) {
          parts.push(el.textRun.content);
        }
      }
    }
    if (element.table) {
      for (const row of element.table.tableRows || []) {
        const cells: string[] = [];
        for (const cell of row.tableCells || []) {
          cells.push(extractText(cell));
        }
        parts.push(cells.join("\t"));
      }
    }
  }
  return parts.join("");
}

export function createDocsReadTool(_api: OpenClawPluginApi) {
  return {
    name: "docs_read",
    label: "Docs Read",
    description: "Read the text content of a Google Doc.",
    parameters: Type.Object({
      documentId: Type.String({ description: "The Google Doc ID (from the URL)." }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const documentId = readString(params, "documentId");
      if (!documentId) throw new Error("documentId is required");

      const doc = (await runGws(["docs", "documents", "get"], {
        params: { documentId },
      })) as any;
      const text = extractText(doc.body);

      return jsonResult({
        documentId: doc.documentId,
        title: doc.title,
        content: text,
      });
    },
  };
}

export function createDocsEditTool(_api: OpenClawPluginApi) {
  return {
    name: "docs_edit",
    label: "Docs Edit",
    description: "Edit a Google Doc by inserting or replacing text.",
    parameters: Type.Object({
      documentId: Type.String({ description: "The Google Doc ID." }),
      insertText: Type.Optional(
        Type.String({ description: "Text to insert at the end of the document." }),
      ),
      replaceText: Type.Optional(
        Type.Object({
          find: Type.String({ description: "Text to find." }),
          replace: Type.String({ description: "Replacement text." }),
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const documentId = readString(params, "documentId");
      if (!documentId) throw new Error("documentId is required");

      const insertText = readString(params, "insertText");
      const replaceText = params.replaceText as { find: string; replace: string } | undefined;

      if (!insertText && !replaceText) {
        throw new Error("Either insertText or replaceText is required");
      }

      const requests: any[] = [];

      if (
        replaceText &&
        typeof replaceText.find === "string" &&
        typeof replaceText.replace === "string"
      ) {
        requests.push({
          replaceAllText: {
            containsText: { text: replaceText.find, matchCase: true },
            replaceText: replaceText.replace,
          },
        });
      }

      if (insertText) {
        requests.push({
          insertText: {
            endOfSegmentLocation: { segmentId: "" },
            text: insertText,
          },
        });
      }

      const result = (await runGws(["docs", "documents", "batchUpdate"], {
        params: { documentId },
        json: { requests },
      })) as any;

      return jsonResult({
        documentId: result.documentId,
        replies: result.replies,
      });
    },
  };
}

export function createDocsCreateTool(_api: OpenClawPluginApi) {
  return {
    name: "docs_create",
    label: "Docs Create",
    description: "Create a new Google Doc.",
    parameters: Type.Object({
      title: Type.String({ description: "Document title." }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const title = readString(params, "title");
      if (!title) throw new Error("title is required");

      const data = (await runGws(["docs", "documents", "create"], {
        json: { title },
      })) as any;

      return jsonResult({
        documentId: data.documentId,
        title: data.title,
      });
    },
  };
}
