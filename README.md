# IBM-Filenet-Traditional-MCP

A custom MCP (Model Context Protocol) server that exposes IBM FileNet Content Engine Web Services (CEWS) and Content Services GraphQL operations as callable tools for AI assistants such as IBM Bob.

Enables an AI assistant to **create**, **query**, and **validate** Choice Lists, Property Templates, Document Class Definitions, and Folder Class Definitions, and to **discover users/groups** and **apply security permissions (ACLs)** directly against a live IBM FileNet environment — no manual copy/paste required.

---

## Connection to FileNet (Traditional CEWS)

This server connects to a traditional IBM FileNet Content Platform Engine deployment using the Content Engine Web Services (CEWS) SOAP endpoint.

### Required environment variables

| Variable | Description | Example |
|---|---|---|
| `FILENET_CEWS_ENDPOINT` | CEWS SOAP service URL | `https://your-host:9443/wsi/FNCEWS40MTOM/` |
| `FILENET_CEWS_WSDL` | CEWS WSDL URL | `https://your-host:9443/wsi/FNCEWS40MTOM?WSDL` |
| `FILENET_REPOSITORY_ID` | Object Store symbolic name | `ECM` |
| `FILENET_USERNAME` | FileNet admin username | `dadmin` |
| `FILENET_PASSWORD` | FileNet admin password | _(keep secret — never commit)_ |
| `FILENET_CEWS_AUTH` | Auth mode: `basic` or `wssecurity` | `wssecurity` |
| `FILENET_TLS_REJECT_UNAUTHORIZED` | `false` only for self-signed/lab certificates | `false` |

> **Note:** `FILENET_TLS_REJECT_UNAUTHORIZED=false` is for lab environments with a self-signed WebSphere certificate only. In production, remove this variable (or set it to `true`) and install a trusted certificate.

### Optional variables (GraphQL tools)

| Variable | Description | Example |
|---|---|---|
| `FILENET_URL` | Content Services GraphQL endpoint | `https://your-host/content-services-graphql/graphql` |
| `FILENET_BASE_URL` | Override REST base URL (auto-derived from `FILENET_URL` if omitted) | `https://your-host/content-services` |
| `FILENET_CEWS_LOCALE` | Locale for CEWS requests | `en-US` |
| `FILENET_CEWS_TIMEZONE` | Timezone for CEWS requests (optional) | `UTC` |

---

## Installation & Usage

### Prerequisites

- Node.js 18 or later
- npm
- Access to a traditional IBM FileNet Content Platform Engine CEWS endpoint

### Clone, build, and register in Bob

```bash
git clone https://github.com/malakelsamman/IBM-Filenet-Traditional-MCP.git
cd IBM-Filenet-Traditional-MCP
npm install
npm run build
```

Then add the following entry to your Bob `mcp.json` (global: `~/.bob/settings/mcp.json`, or workspace: `.bob/mcp.json`):

```json
{
  "mcpServers": {
    "filenet-cews-mcp-server": {
      "command": "node",
      "args": ["C:/path/to/IBM-Filenet-Traditional-MCP/build/index.js"],
      "env": {
        "FILENET_CEWS_ENDPOINT": "https://your-host:9443/wsi/FNCEWS40MTOM/",
        "FILENET_CEWS_WSDL": "https://your-host:9443/wsi/FNCEWS40MTOM?WSDL",
        "FILENET_REPOSITORY_ID": "ECM",
        "FILENET_USERNAME": "dadmin",
        "FILENET_PASSWORD": "your-password",
        "FILENET_CEWS_AUTH": "wssecurity",
        "FILENET_TLS_REJECT_UNAUTHORIZED": "false"
      }
    }
  }
}
```

Replace the `args` path with the actual location where you cloned this repo.

### Keeping the server up to date

```bash
cd IBM-Filenet-Traditional-MCP
git pull
npm install
npm run build
```

Restart Bob after rebuilding so it picks up the updated binary.

---

## Project structure

```
IBM-Filenet-Traditional-MCP/
├── src/
│   ├── index.ts                  ← MCP server entry point — registers all tools
│   ├── client.ts                 ← FileNet GraphQL HTTP client (auth, base URL, error handling)
│   ├── cews/
│   │   └── client.ts             ← CEWS SOAP client (WSSecurity/Basic auth, SOAP helpers)
│   └── tools/
│       ├── choiceList.ts         ← create_choice_list, list_choice_lists, get_choice_list
│       ├── propertyTemplate.ts   ← create_property_template, list_property_templates, get_property_template
│       ├── documentClass.ts      ← create_document_class, list_document_classes, get_document_class
│       ├── folderClass.ts        ← create_folder_class, list_folder_classes
│       ├── security.ts           ← get_current_user, get_user, get_group,
│       │                            search_users, search_groups, list_realms,
│       │                            update_document_security, update_folder_security
│       ├── search.ts             ← cews_execute_search, cews_get_search_metadata, cews_get_object
│       ├── eventAction.ts        ← create_event_action, update_event_action, get_event_action,
│       │                            search_event_actions, delete_event_action
│       └── cews.ts               ← cews_connection_info, cews_update_folder_security,
│                                    cews_create_document
├── graphql/
│   ├── mutations/
│   │   ├── createChoiceList.graphql
│   │   ├── createPropertyTemplate.graphql
│   │   ├── createDocumentClass.graphql
│   │   ├── createFolderClass.graphql
│   │   └── updateObjectSecurity.graphql
│   └── queries/
│       ├── listChoiceLists.graphql
│       ├── listPropertyTemplates.graphql
│       ├── listClassDefinitions.graphql
│       └── lookupUsersAndGroups.graphql
├── .env.example                  ← Template for all environment variables
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Tools exposed

### Choice Lists
| Tool | Description |
|---|---|
| `create_choice_list` | Creates a new choice list |
| `list_choice_lists` | Queries existing choice lists |
| `get_choice_list` | Returns a single choice list by id or name |

### Property Templates
| Tool | Description |
|---|---|
| `create_property_template` | Creates a new property template |
| `list_property_templates` | Lists property templates |
| `get_property_template` | Returns a single property template by symbolic name or GUID |

### Document & Folder Classes
| Tool | Description |
|---|---|
| `create_document_class` | Creates a custom document subclass |
| `list_document_classes` | Lists document class definitions |
| `get_document_class` | Returns a class definition with its bound properties |
| `create_folder_class` | Creates a custom folder subclass |
| `list_folder_classes` | Lists folder class definitions |

### Users, Groups & Security
| Tool | Description |
|---|---|
| `get_current_user` | Returns the authenticated user's identity |
| `get_user` | Looks up a single user |
| `get_group` | Looks up a single group |
| `search_users` | Finds users matching a name pattern |
| `search_groups` | Finds groups matching a name pattern |
| `list_realms` | Lists all LDAP realms in the domain |
| `update_document_security` | Replaces the full ACL on a document |
| `update_folder_security` | Replaces the full ACL on a folder (GraphQL) |

### Traditional CEWS Tools
| Tool | Description |
|---|---|
| `cews_connection_info` | Shows configured CEWS endpoint and settings |
| `cews_get_search_metadata` | Read-only CEWS connectivity test |
| `cews_execute_search` | Executes a CE SQL search via CEWS |
| `cews_get_object` | Retrieves an object by GUID via CEWS |
| `cews_update_folder_security` | Replaces folder ACL via native CEWS ExecuteChanges |
| `cews_create_document` | Creates a text document via native CEWS ExecuteChanges |

### Event Actions (Webhooks)
| Tool | Description |
|---|---|
| `create_event_action` | Creates a new Content Event Webhook |
| `update_event_action` | Updates an existing event action |
| `get_event_action` | Retrieves an event action by id or name |
| `search_event_actions` | Searches for event actions |
| `delete_event_action` | Deletes an event action |

---

## Related resources

- [IBM FileNet Content Services documentation](https://www.ibm.com/docs/en/filenet-p8-platform)
- [Model Context Protocol SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [IBM Bob AI assistant](https://www.ibm.com/docs/en/bob)
