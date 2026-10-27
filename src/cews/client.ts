import "dotenv/config";
import https from "node:https";
import axios from "axios";
import {
  BasicAuthSecurity,
  Client,
  createClientAsync,
  HttpClient,
  WSSecurity,
} from "soap";

const SCHEMA_NS = "http://www.filenet.com/ns/fnce/2006/11/ws/schema";

type CewsConfig = {
  endpoint: string;
  wsdl: string;
  username: string;
  password: string;
  authMode: "basic" | "wssecurity";
  repositoryId: string;
  rejectUnauthorized: boolean;
  locale: string;
  timezone?: string;
};

let clientPromise: Promise<Client> | undefined;

function getConfig(): CewsConfig {
  const endpoint =
    process.env.FILENET_CEWS_ENDPOINT ??
    process.env.FILENET_CEWS_URL ??
    "https://localhost:9443/wsi/FNCEWS40MTOM/";
  const wsdl =
    process.env.FILENET_CEWS_WSDL ??
    (endpoint.endsWith("/") ? `${endpoint}?WSDL` : `${endpoint}/?WSDL`);
  const username = process.env.FILENET_USERNAME;
  const password = process.env.FILENET_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Missing CEWS credentials. Set FILENET_USERNAME and FILENET_PASSWORD in the MCP process environment."
    );
  }

  const authMode = (process.env.FILENET_CEWS_AUTH ?? "basic").toLowerCase();
  if (authMode !== "basic" && authMode !== "wssecurity") {
    throw new Error("FILENET_CEWS_AUTH must be either 'basic' or 'wssecurity'.");
  }

  return {
    endpoint,
    wsdl,
    username,
    password,
    authMode,
    repositoryId: process.env.FILENET_REPOSITORY_ID ?? "ECM",
    // Set to false only for a lab with the self-signed WebSphere certificate.
    rejectUnauthorized: process.env.FILENET_TLS_REJECT_UNAUTHORIZED !== "false",
    locale: process.env.FILENET_CEWS_LOCALE ?? "en-US",
    timezone: process.env.FILENET_CEWS_TIMEZONE,
  };
}

function objectStoreScope(repositoryId: string): Record<string, unknown> {
  return {
    attributes: {
      xsi_type: {
        prefix: "ctyp",
        type: "ObjectStoreScope",
        xmlns: SCHEMA_NS,
      },
      objectStore: repositoryId,
    },
  };
}

async function createCewsClient(): Promise<Client> {
  const config = getConfig();
  const httpsAgent = new https.Agent({ rejectUnauthorized: config.rejectUnauthorized });
  const client = await createClientAsync(
    config.wsdl,
    {
      forceSoap12Headers: true,
      // soap's bundled Axios type and the application's Axios type can differ
      // even when npm deduplicates them to the same runtime package.
      httpClient: new HttpClient({ request: axios.create({ httpsAgent }) as any }),
      wsdl_options: {
        rejectUnauthorized: config.rejectUnauthorized,
        httpsAgent,
      },
    },
    config.endpoint
  );

  client.setEndpoint(config.endpoint);

  if (config.authMode === "wssecurity") {
    client.setSecurity(
      new WSSecurity(config.username, config.password, {
        passwordType: "PasswordText",
        hasTimeStamp: true,
      })
    );
  } else {
    client.setSecurity(new BasicAuthSecurity(config.username, config.password));
  }

  const timezone = config.timezone
    ? `<ctyp:Timezone>${escapeXml(config.timezone)}</ctyp:Timezone>`
    : "";
  client.addSoapHeader(
    `<ctyp:Localization xmlns:ctyp="${SCHEMA_NS}">` +
      `<ctyp:Locale>${escapeXml(config.locale)}</ctyp:Locale>` +
      timezone +
      `</ctyp:Localization>`
  );

  return client;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function getClient(): Promise<Client> {
  clientPromise ??= createCewsClient().catch((error) => {
    clientPromise = undefined;
    throw error;
  });
  return clientPromise;
}

function formatCewsError(error: unknown): string {
  if (error instanceof Error) {
    const details = error as Error & {
      body?: unknown;
      code?: unknown;
      statusCode?: unknown;
      root?: unknown;
    };
    const extra = {
      code: details.code,
      statusCode: details.statusCode,
      body: details.body,
      root: details.root,
    };
    const serialized = JSON.stringify(extra, redactErrorFields);
    return serialized && serialized !== "{}"
      ? `${details.message}; details=${serialized.slice(0, 12000)}`
      : details.message;
  }

  if (typeof error === "object" && error !== null) {
    return JSON.stringify(error, redactErrorFields).slice(0, 12000);
  }

  return String(error);
}

function redactErrorFields(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes("password") || normalizedKey === "authorization") {
    return "[redacted]";
  }
  return value;
}

export function getCewsConnectionInfo(): Record<string, unknown> {
  const config = getConfig();
  return {
    endpoint: config.endpoint,
    wsdl: config.wsdl,
    repositoryId: config.repositoryId,
    authMode: config.authMode,
    tlsCertificateValidation: config.rejectUnauthorized,
    locale: config.locale,
    timezone: config.timezone ?? null,
  };
}

export function getCewsRepositoryId(): string {
  return getConfig().repositoryId;
}

export function makeObjectStoreScope(repositoryId = getCewsRepositoryId()): Record<string, unknown> {
  return objectStoreScope(repositoryId);
}

export function buildRepositorySearchXml(input: {
  repositoryId: string;
  searchSql: string;
  maxElements: number;
  continueFrom?: string;
  includeProperties?: string[];
}): string {
  const attributes = [
    `xsi:type="ctyp:RepositorySearch"`,
    `maxElements="${escapeXml(String(input.maxElements))}"`,
    `continuable="true"`,
    `repositorySearchMode="Objects"`,
    ...(input.continueFrom
      ? [`continueFrom="${escapeXml(input.continueFrom)}"`]
      : []),
  ].join(" ");
  const selectionFilter = input.includeProperties?.length
    ? `<ctyp:SelectionFilter>${input.includeProperties
        .map((property) => `<ctyp:IncludeProperties>${escapeXml(property)}</ctyp:IncludeProperties>`)
        .join("")}</ctyp:SelectionFilter>`
    : "";

  // Use the WSDL's raw XML escape hatch for ExecuteSearch. The generated
  // node-soap document serializer redeclares ctyp on the request root, which
  // traditional Content Engine WSI rejects as a duplicate namespace.
  return (
    `<ctyp:ExecuteSearchRequest ${attributes}>` +
      selectionFilter +
      `<ctyp:SearchScope xsi:type="ctyp:ObjectStoreScope" objectStore="${escapeXml(input.repositoryId)}"/>` +
      `<ctyp:SearchSQL>${escapeXml(input.searchSql)}</ctyp:SearchSQL>` +
      `</ctyp:ExecuteSearchRequest>`
  );
}

export type CewsFolderPermission = {
  granteeName: string;
  accessType: "ALLOW" | "DENY";
  accessMask: number;
  inheritableDepth: number;
};

/**
 * Builds the raw CEWS ExecuteChanges body for replacing the stored ACL on a
 * Folder.  Raw XML is intentional here for the same reason as ExecuteSearch:
 * node-soap's generated serializer can redeclare CEWS namespaces in a form
 * rejected by traditional Content Engine WSI.
 *
 * The permissions passed to this function are the ACL entries to store on the
 * folder.  Parent-inherited ACEs are not stored on the child and should not
 * be included when the caller wants inheritance to remain intact.
 */
export function buildFolderSecurityChangesXml(input: {
  repositoryId: string;
  objectId: string;
  permissions: CewsFolderPermission[];
  updateSequenceNumber?: number;
}): string {
  const updateSequenceNumber = input.updateSequenceNumber === undefined
    ? ""
    : ` updateSequenceNumber="${escapeXml(String(input.updateSequenceNumber))}"`;

  const permissionValues = input.permissions
    .map((permission, index) => {
      const accessType = permission.accessType === "ALLOW" ? 1 : 0;
      return (
        `<ctyp:Value classId="AccessPermission" dependentAction="Insert" ` +
          `newIndex="${index}" xsi:type="ctyp:DependentObjectType">` +
          singletonIntegerProperty("InheritableDepth", permission.inheritableDepth) +
          singletonStringProperty("GranteeName", permission.granteeName) +
          singletonIntegerProperty("AccessType", accessType) +
          singletonIntegerProperty("AccessMask", permission.accessMask) +
        `</ctyp:Value>`
      );
    })
    .join("");

  return (
    `<ctyp:ExecuteChangesRequest refresh="true">` +
      `<ctyp:ChangeRequest id="folder-security-change-1"${updateSequenceNumber}>` +
        `<ctyp:TargetSpecification classId="Folder" ` +
          `objectId="${escapeXml(input.objectId)}" ` +
          `objectStore="${escapeXml(input.repositoryId)}"/>` +
        `<ctyp:Action xsi:type="ctyp:UpdateAction"/>` +
        `<ctyp:ActionProperties>` +
          `<ctyp:Property propertyId="Permissions" listMode="Replace" ` +
            `xsi:type="ctyp:ListOfObject">` +
            permissionValues +
          `</ctyp:Property>` +
        `</ctyp:ActionProperties>` +
        `<ctyp:RefreshFilter maxRecursion="1" maxElements="1000" ` +
          `levelDependents="true">` +
          `<ctyp:IncludeProperties levelDependents="true" ` +
            `maxRecursion="1" maxElements="1000">Id</ctyp:IncludeProperties>` +
        `</ctyp:RefreshFilter>` +
      `</ctyp:ChangeRequest>` +
    `</ctyp:ExecuteChangesRequest>`
  );
}

/**
 * Builds a small, self-contained CEWS document creation request for the POC.
 * The document is created as a major version and receives one inline content
 * element. Filing is performed separately by creating a dynamic referential
 * containment relationship, which is the native CE model for current document
 * versions.
 */
export function buildCreateTextDocumentChangesXml(input: {
  repositoryId: string;
  objectStoreId: string;
  documentClass: string;
  documentTitle: string;
  contentText: string;
  contentType: string;
}): string {
  const contentBase64 = Buffer.from(input.contentText, "utf8").toString("base64");

  return (
    `<ctyp:ExecuteChangesRequest refresh="true">` +
      `<ctyp:ChangeRequest id="create-document-change-1">` +
        `<ctyp:TargetSpecification classId="ObjectStore" ` +
          `objectId="${escapeXml(input.objectStoreId)}"/>` +
        `<ctyp:Action classId="${escapeXml(input.documentClass)}" ` +
          `defineSecurityParentage="false" xsi:type="ctyp:CreateAction"/>` +
        `<ctyp:Action checkinMinorVersion="false" ` +
          `xsi:type="ctyp:CheckinAction"/>` +
        `<ctyp:ActionProperties>` +
          singletonStringProperty("DocumentTitle", input.documentTitle) +
          `<ctyp:Property propertyId="ContentElements" ` +
            `xsi:type="ctyp:ListOfObject">` +
            `<ctyp:Value classId="ContentTransfer" dependentAction="Insert" ` +
              `newIndex="0" xsi:type="ctyp:DependentObjectType">` +
              singletonStringProperty("ContentType", input.contentType) +
              singletonStringProperty("RetrievalName", `${input.documentTitle}.txt`) +
              `<ctyp:Property propertyId="Content" xsi:type="ctyp:ContentData">` +
                `<ctyp:Value xsi:type="ctyp:InlineContent">` +
                  `<ctyp:Binary>${escapeXml(contentBase64)}</ctyp:Binary>` +
                `</ctyp:Value>` +
              `</ctyp:Property>` +
            `</ctyp:Value>` +
          `</ctyp:Property>` +
        `</ctyp:ActionProperties>` +
        `<ctyp:RefreshFilter maxRecursion="1" maxElements="1000" ` +
          `levelDependents="false">` +
          `<ctyp:IncludeProperties>Id</ctyp:IncludeProperties>` +
          `<ctyp:IncludeProperties>DocumentTitle</ctyp:IncludeProperties>` +
        `</ctyp:RefreshFilter>` +
      `</ctyp:ChangeRequest>` +
    `</ctyp:ExecuteChangesRequest>`
  );
}

export function buildCreateDynamicContainmentChangesXml(input: {
  repositoryId: string;
  objectStoreId: string;
  documentId: string;
  folderId: string;
  containmentName: string;
}): string {
  return (
    `<ctyp:ExecuteChangesRequest refresh="true">` +
      `<ctyp:ChangeRequest id="create-containment-change-1">` +
        `<ctyp:TargetSpecification classId="ObjectStore" ` +
          `objectId="${escapeXml(input.objectStoreId)}"/>` +
        `<ctyp:Action classId="DynamicReferentialContainmentRelationship" ` +
          `autoUniqueContainmentName="true" defineSecurityParentage="true" ` +
          `xsi:type="ctyp:CreateAction"/>` +
        `<ctyp:ActionProperties>` +
          objectReferenceProperty("Head", "Document", input.documentId, input.repositoryId) +
          objectReferenceProperty("Tail", "Folder", input.folderId, input.repositoryId) +
          singletonStringProperty("ContainmentName", input.containmentName) +
        `</ctyp:ActionProperties>` +
        `<ctyp:RefreshFilter maxRecursion="1" maxElements="1000" ` +
          `levelDependents="false">` +
          `<ctyp:IncludeProperties>Id</ctyp:IncludeProperties>` +
        `</ctyp:RefreshFilter>` +
      `</ctyp:ChangeRequest>` +
    `</ctyp:ExecuteChangesRequest>`
  );
}

function objectReferenceProperty(
  propertyId: string,
  classId: string,
  objectId: string,
  objectStore: string
): string {
  return (
    `<ctyp:Property propertyId="${escapeXml(propertyId)}" ` +
      `xsi:type="ctyp:SingletonObject">` +
      `<ctyp:Value classId="${escapeXml(classId)}" ` +
        `objectId="${escapeXml(objectId)}" ` +
        `objectStore="${escapeXml(objectStore)}" ` +
        `xsi:type="ctyp:ObjectReference"/>` +
    `</ctyp:Property>`
  );
}

export function extractFirstObjectId(value: unknown): string | undefined {
  const guidPattern = /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/;
  const seen = new WeakSet<object>();

  function visit(current: unknown): string | undefined {
    if (typeof current === "string") {
      return guidPattern.test(current) ? current : undefined;
    }
    if (!current || typeof current !== "object") return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }

    const record = current as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (key.toLowerCase() === "objectid" && typeof nested === "string" && guidPattern.test(nested)) {
        return nested;
      }
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found) return found;
    }
    return undefined;
  }

  return visit(value);
}

function singletonStringProperty(propertyId: string, value: string): string {
  return (
    `<ctyp:Property propertyId="${escapeXml(propertyId)}" ` +
      `xsi:type="ctyp:SingletonString">` +
      `<ctyp:Value>${escapeXml(value)}</ctyp:Value>` +
    `</ctyp:Property>`
  );
}

function singletonIntegerProperty(propertyId: string, value: number): string {
  return (
    `<ctyp:Property propertyId="${escapeXml(propertyId)}" ` +
      `xsi:type="ctyp:SingletonInteger32">` +
      `<ctyp:Value>${escapeXml(String(value))}</ctyp:Value>` +
    `</ctyp:Property>`
  );
}

export async function executeCews<T = unknown>(
  operation: "GetObjects" | "ExecuteSearch" | "GetSearchMetadata" | "GetContent" | "ExecuteChanges",
  args: Record<string, unknown>
): Promise<T> {
  const client = await getClient();
  const methodName = `${operation}Async`;
  const method = (client as unknown as Record<string, unknown>)[methodName];

  if (typeof method !== "function") {
    throw new Error(`The CEWS WSDL does not expose operation ${operation}.`);
  }

  try {
    const result = await (method as (input: Record<string, unknown>) => Promise<unknown[]>).call(
      client,
      args
    );
    return result[0] as T;
  } catch (error) {
    throw new Error(`CEWS ${operation} failed: ${formatCewsError(error)}`);
  }
}

export function buildSelectionFilter(
  includeProperties: string[],
  options: { expandDependents?: boolean; maxElements?: number; maxRecursion?: number } = {}
): Record<string, unknown> {
  if (options.expandDependents) {
    const maxElements = options.maxElements ?? 1000;
    const maxRecursion = options.maxRecursion ?? 1;
    return {
      attributes: {
        levelDependents: true,
        maxElements,
        maxRecursion,
      },
      IncludeProperties: includeProperties.map((property) => ({
        attributes: {
          levelDependents: true,
          maxElements,
          maxRecursion,
        },
        $value: property,
      })),
      // Include scalar and collection properties on the dependent
      // AccessPermission objects themselves, not only the Permissions list
      // property on the parent Folder.
      IncludeTypes: ["Singleton*", "List*", "EnumOfObject"].map((type) => ({
        attributes: {
          levelDependents: true,
          maxElements,
          maxRecursion,
        },
        $value: type,
      })),
    };
  }

  return {
    IncludeProperties: includeProperties,
  };
}
