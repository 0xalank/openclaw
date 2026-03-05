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

export function createSheetsReadTool(_api: OpenClawPluginApi) {
  return {
    name: "sheets_read",
    label: "Sheets Read",
    description: "Read data from a Google Sheets spreadsheet.",
    parameters: Type.Object({
      spreadsheetId: Type.String({ description: "The spreadsheet ID (from the URL)." }),
      range: Type.String({ description: "A1 notation range (e.g., 'Sheet1!A1:D10')." }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const spreadsheetId = readString(params, "spreadsheetId");
      const range = readString(params, "range");
      if (!spreadsheetId || !range) throw new Error("spreadsheetId and range are required");

      const data = (await runGws(["sheets", "spreadsheets", "values", "get"], {
        params: { spreadsheetId, range },
      })) as any;

      return jsonResult({
        range: data.range,
        values: data.values || [],
        majorDimension: data.majorDimension,
      });
    },
  };
}

export function createSheetsWriteTool(_api: OpenClawPluginApi) {
  return {
    name: "sheets_write",
    label: "Sheets Write",
    description: "Write data to a Google Sheets spreadsheet.",
    parameters: Type.Object({
      spreadsheetId: Type.String({ description: "The spreadsheet ID." }),
      range: Type.String({ description: "A1 notation range (e.g., 'Sheet1!A1')." }),
      values: Type.Array(Type.Array(Type.Any()), { description: "2D array of values to write." }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const spreadsheetId = readString(params, "spreadsheetId");
      const range = readString(params, "range");
      const values = params.values;
      if (!spreadsheetId || !range) throw new Error("spreadsheetId and range are required");
      if (!Array.isArray(values)) throw new Error("values must be a 2D array");

      const data = (await runGws(["sheets", "spreadsheets", "values", "update"], {
        params: { spreadsheetId, range, valueInputOption: "USER_ENTERED" },
        json: { range, majorDimension: "ROWS", values },
      })) as any;

      return jsonResult({
        updatedRange: data.updatedRange,
        updatedRows: data.updatedRows,
        updatedColumns: data.updatedColumns,
        updatedCells: data.updatedCells,
      });
    },
  };
}

export function createSheetsCreateTool(_api: OpenClawPluginApi) {
  return {
    name: "sheets_create",
    label: "Sheets Create",
    description: "Create a new Google Sheets spreadsheet.",
    parameters: Type.Object({
      title: Type.String({ description: "Spreadsheet title." }),
      sheetNames: Type.Optional(
        Type.Array(Type.String(), { description: "Sheet tab names (default: ['Sheet1'])." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const title = readString(params, "title");
      if (!title) throw new Error("title is required");
      const sheetNames = Array.isArray(params.sheetNames)
        ? (params.sheetNames as unknown[])
            .filter((v) => typeof v === "string")
            .map((v) => v as string)
        : ["Sheet1"];

      const data = (await runGws(["sheets", "spreadsheets", "create"], {
        json: {
          properties: { title },
          sheets: sheetNames.map((name) => ({ properties: { title: name } })),
        },
      })) as any;

      return jsonResult({
        spreadsheetId: data.spreadsheetId,
        spreadsheetUrl: data.spreadsheetUrl,
        title: data.properties?.title,
        sheets: (data.sheets || []).map((s: any) => s.properties?.title),
      });
    },
  };
}

export function createSheetsAppendTool(_api: OpenClawPluginApi) {
  return {
    name: "sheets_append",
    label: "Sheets Append",
    description: "Append rows to a Google Sheets spreadsheet.",
    parameters: Type.Object({
      spreadsheetId: Type.String({ description: "The spreadsheet ID." }),
      range: Type.String({ description: "A1 notation range to append after (e.g., 'Sheet1!A1')." }),
      values: Type.Array(Type.Array(Type.Any()), { description: "2D array of rows to append." }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const spreadsheetId = readString(params, "spreadsheetId");
      const range = readString(params, "range");
      const values = params.values;
      if (!spreadsheetId || !range) throw new Error("spreadsheetId and range are required");
      if (!Array.isArray(values)) throw new Error("values must be a 2D array");

      const data = (await runGws(["sheets", "spreadsheets", "values", "append"], {
        params: {
          spreadsheetId,
          range,
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
        },
        json: { majorDimension: "ROWS", values },
      })) as any;

      return jsonResult({
        updatedRange: data.updates?.updatedRange,
        updatedRows: data.updates?.updatedRows,
        updatedColumns: data.updates?.updatedColumns,
        updatedCells: data.updates?.updatedCells,
      });
    },
  };
}
