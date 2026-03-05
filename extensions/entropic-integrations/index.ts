import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createCalendarListTool, createCalendarCreateTool } from "./src/calendar-tools.js";
import { createContactsListTool, createContactsSearchTool } from "./src/contacts-tools.js";
import { createDocsReadTool, createDocsEditTool, createDocsCreateTool } from "./src/docs-tools.js";
import {
  createDriveListTool,
  createDriveSearchTool,
  createDriveDownloadTool,
  createDriveUploadTool,
  createDriveShareTool,
  createDriveCreateFolderTool,
} from "./src/drive-tools.js";
import { registerIntegrationGatewayMethods } from "./src/gateway.js";
import {
  createGmailSearchTool,
  createGmailSendTool,
  createGmailGetTool,
  createGmailDraftTool,
} from "./src/gmail-tools.js";
import {
  createSheetsReadTool,
  createSheetsWriteTool,
  createSheetsCreateTool,
  createSheetsAppendTool,
} from "./src/sheets-tools.js";
import {
  createTasksListTool,
  createTasksCreateTool,
  createTasksUpdateTool,
} from "./src/tasks-tools.js";

const plugin = {
  id: "entropic-integrations",
  name: "Entropic Integrations",
  description: "OAuth bridge tools for Entropic integrations",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    registerIntegrationGatewayMethods(api);
    // Gmail
    api.registerTool(createGmailSearchTool(api), { optional: true });
    api.registerTool(createGmailGetTool(api), { optional: true });
    api.registerTool(createGmailSendTool(api), { optional: true });
    api.registerTool(createGmailDraftTool(api), { optional: true });
    // Calendar
    api.registerTool(createCalendarListTool(api), { optional: true });
    api.registerTool(createCalendarCreateTool(api), { optional: true });
    // Drive
    api.registerTool(createDriveListTool(api), { optional: true });
    api.registerTool(createDriveSearchTool(api), { optional: true });
    api.registerTool(createDriveDownloadTool(api), { optional: true });
    api.registerTool(createDriveUploadTool(api), { optional: true });
    api.registerTool(createDriveShareTool(api), { optional: true });
    api.registerTool(createDriveCreateFolderTool(api), { optional: true });
    // Sheets
    api.registerTool(createSheetsReadTool(api), { optional: true });
    api.registerTool(createSheetsWriteTool(api), { optional: true });
    api.registerTool(createSheetsCreateTool(api), { optional: true });
    api.registerTool(createSheetsAppendTool(api), { optional: true });
    // Docs
    api.registerTool(createDocsReadTool(api), { optional: true });
    api.registerTool(createDocsEditTool(api), { optional: true });
    api.registerTool(createDocsCreateTool(api), { optional: true });
    // Contacts
    api.registerTool(createContactsListTool(api), { optional: true });
    api.registerTool(createContactsSearchTool(api), { optional: true });
    // Tasks
    api.registerTool(createTasksListTool(api), { optional: true });
    api.registerTool(createTasksCreateTool(api), { optional: true });
    api.registerTool(createTasksUpdateTool(api), { optional: true });
  },
};

export default plugin;
