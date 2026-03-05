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

function readBoolean(
  params: Record<string, unknown>,
  key: string,
  def?: boolean,
): boolean | undefined {
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return def;
}

export function createTasksListTool(_api: OpenClawPluginApi) {
  return {
    name: "tasks_list",
    label: "Tasks List",
    description:
      "List tasks from Google Tasks. Use taskListId to specify which list, or omit for the default list.",
    parameters: Type.Object({
      taskListId: Type.Optional(
        Type.String({ description: "Task list ID (omit for default list)." }),
      ),
      showCompleted: Type.Optional(
        Type.Boolean({ description: "Include completed tasks (default false)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const taskListId = readString(params, "taskListId") || "@default";
      const showCompleted = readBoolean(params, "showCompleted", false) ?? false;

      const data = (await runGws(["tasks", "tasks", "list"], {
        params: {
          tasklist: taskListId,
          maxResults: 100,
          showCompleted,
        },
      })) as any;

      return jsonResult({
        tasks: (data.items || []).map((t: any) => ({
          id: t.id,
          title: t.title,
          notes: t.notes || null,
          status: t.status,
          due: t.due || null,
          updated: t.updated,
        })),
      });
    },
  };
}

export function createTasksCreateTool(_api: OpenClawPluginApi) {
  return {
    name: "tasks_create",
    label: "Tasks Create",
    description: "Create a new task in Google Tasks.",
    parameters: Type.Object({
      title: Type.String({ description: "Task title." }),
      notes: Type.Optional(Type.String({ description: "Task notes/description." })),
      due: Type.Optional(
        Type.String({
          description: "Due date in RFC 3339 format (e.g., '2026-03-15T00:00:00.000Z').",
        }),
      ),
      taskListId: Type.Optional(
        Type.String({ description: "Task list ID (omit for default list)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const title = readString(params, "title");
      if (!title) throw new Error("title is required");
      const taskListId = readString(params, "taskListId") || "@default";

      const payload: any = { title };
      const notes = readString(params, "notes");
      if (notes) payload.notes = notes;
      const due = readString(params, "due");
      if (due) payload.due = due;

      const data = (await runGws(["tasks", "tasks", "insert"], {
        params: { tasklist: taskListId },
        json: payload,
      })) as any;

      return jsonResult({
        id: data.id,
        title: data.title,
        status: data.status,
        due: data.due || null,
      });
    },
  };
}

export function createTasksUpdateTool(_api: OpenClawPluginApi) {
  return {
    name: "tasks_update",
    label: "Tasks Update",
    description: "Update an existing task in Google Tasks (mark complete, change title, etc.).",
    parameters: Type.Object({
      taskId: Type.String({ description: "The task ID." }),
      taskListId: Type.Optional(
        Type.String({ description: "Task list ID (omit for default list)." }),
      ),
      title: Type.Optional(Type.String({ description: "New title." })),
      notes: Type.Optional(Type.String({ description: "New notes." })),
      status: Type.Optional(
        Type.String({ description: "Task status: 'needsAction' or 'completed'." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const taskId = readString(params, "taskId");
      if (!taskId) throw new Error("taskId is required");
      const taskListId = readString(params, "taskListId") || "@default";

      const patch: any = {};
      const title = readString(params, "title");
      if (title) patch.title = title;
      const notes = readString(params, "notes");
      if (notes !== undefined) patch.notes = notes;
      const status = readString(params, "status");
      if (status) patch.status = status;

      const data = (await runGws(["tasks", "tasks", "patch"], {
        params: { tasklist: taskListId, task: taskId },
        json: patch,
      })) as any;

      return jsonResult({
        id: data.id,
        title: data.title,
        status: data.status,
        due: data.due || null,
        updated: data.updated,
      });
    },
  };
}
