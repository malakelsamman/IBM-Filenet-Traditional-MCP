import { z } from "zod";
import { buildCreateDynamicContainmentChangesXml, buildCreateTextDocumentChangesXml, buildFolderSecurityChangesXml, buildRepositorySearchXml, buildSelectionFilter, executeCews, extractFirstObjectId, getCewsConnectionInfo, makeObjectStoreScope, } from "../cews/client.js";
const accessPermissionInput = z.object({
    type: z.literal("ACCESS_PERMISSION").default("ACCESS_PERMISSION"),
    inheritableDepth: z
        .union([
        z.number().int().min(-1),
        z.enum(["OBJECT_ONLY", "IMMEDIATE_CHILDREN", "ALL_CHILDREN"]),
    ])
        .default("OBJECT_ONLY")
        .describe("0/object only, 1/immediate children, -1/all children, or a named equivalent."),
    accessMask: z.number().int().describe("FileNet access mask, for example 999415 or 131073."),
    subAccessPermission: z.object({
        accessType: z.enum(["ALLOW", "DENY"]),
        granteeName: z.string(),
    }),
});
function normalizeInheritableDepth(value) {
    if (typeof value === "number")
        return value;
    if (value === "ALL_CHILDREN")
        return -1;
    if (value === "IMMEDIATE_CHILDREN")
        return 1;
    return 0;
}
const cewsSearchInput = z.object({
    repositoryId: z
        .string()
        .default("ECM")
        .describe("FileNet object store symbolic name. The supplied POC uses ECM."),
    searchSql: z
        .string()
        .describe("Content Engine SQL, for example SELECT Id, Name FROM Folder WHERE Name = 'CIB 2026'."),
    maxElements: z
        .number()
        .int()
        .positive()
        .max(1000)
        .default(50)
        .describe("Maximum number of objects to return in this page."),
    continueFrom: z
        .string()
        .optional()
        .describe("Continuation token returned by a previous CEWS search page."),
    includeProperties: z
        .array(z.string())
        .optional()
        .describe("Optional property filter, for example ['Permissions', 'FoldersFiledIn']."),
});
function textResult(value) {
    return {
        content: [{ type: "text", text: stringifyForMcp(value) }],
    };
}
function stringifyForMcp(value) {
    if (typeof value === "string")
        return value;
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, nestedValue) => {
            if (typeof nestedValue === "object" && nestedValue !== null) {
                if (seen.has(nestedValue))
                    return "[Circular]";
                seen.add(nestedValue);
            }
            return nestedValue;
        }, 2);
    }
    catch (error) {
        return `Unable to serialize CEWS response: ${error instanceof Error ? error.message : String(error)}`;
    }
}
function errorResult(prefix, error) {
    return {
        content: [
            {
                type: "text",
                text: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
            },
        ],
        isError: true,
    };
}
export function registerCewsTools(server) {
    server.registerTool("cews_connection_info", {
        description: "Shows the configured CEWS endpoint, WSDL, object store, authentication mode, and TLS setting. " +
            "It never returns the password and does not call FileNet.",
        inputSchema: z.object({}),
    }, async () => {
        try {
            return textResult(getCewsConnectionInfo());
        }
        catch (error) {
            return errorResult("Failed to read CEWS configuration", error);
        }
    });
    server.registerTool("cews_get_search_metadata", {
        description: "Read-only CEWS connectivity test. Asks traditional FileNet for search metadata for a class in the configured object store. " +
            "Use this before any document, folder, or security write.",
        inputSchema: z.object({
            repositoryId: z.string().default("ECM"),
            classFilter: z.string().default("Document"),
            includeProperties: z.array(z.string()).optional(),
        }),
    }, async ({ repositoryId, classFilter, includeProperties }) => {
        try {
            const result = await executeCews("GetSearchMetadata", {
                SearchScope: makeObjectStoreScope(repositoryId),
                ClassFilter: classFilter,
                ...(includeProperties
                    ? { PropertyFilter: buildSelectionFilter(includeProperties) }
                    : {}),
            });
            return textResult(result);
        }
        catch (error) {
            return errorResult("Failed to retrieve CEWS search metadata", error);
        }
    });
    server.registerTool("cews_execute_search", {
        description: "Executes a read-only Content Engine SQL search through traditional FileNet CEWS. " +
            "This is the first tool to use to locate CIB 2026, Folder 1, Folder 2, and the POC documents.",
        inputSchema: cewsSearchInput,
    }, async ({ repositoryId, searchSql, maxElements, continueFrom, includeProperties }) => {
        try {
            const result = await executeCews("ExecuteSearch", {
                _xml: buildRepositorySearchXml({
                    repositoryId,
                    searchSql,
                    maxElements,
                    continueFrom,
                    includeProperties,
                }),
            });
            return textResult(result);
        }
        catch (error) {
            return errorResult("Failed to execute CEWS search", error);
        }
    });
    server.registerTool("cews_get_object", {
        description: "Read-only CEWS object retrieval by GUID. Use it to inspect an object and, when requested, its Permissions property. " +
            "The caller must supply a GUID returned by cews_execute_search.",
        inputSchema: z.object({
            repositoryId: z.string().default("ECM"),
            objectId: z.string().describe("FileNet object GUID, including braces."),
            classId: z
                .string()
                .describe("FileNet class name, for example Folder or Document. Required for reliable CEWS retrieval."),
            includeProperties: z
                .array(z.string())
                .default(["Id", "Name", "Permissions"])
                .describe("Properties to retrieve. Permissions is included by default for the POC."),
        }),
    }, async ({ repositoryId, objectId, classId, includeProperties }) => {
        try {
            const result = await executeCews("GetObjects", {
                ObjectRequest: [
                    {
                        attributes: { id: "object-1", maxElements: 1 },
                        SourceSpecification: {
                            attributes: {
                                objectId,
                                objectStore: repositoryId,
                                ...(classId ? { classId } : {}),
                            },
                        },
                        PropertyFilter: buildSelectionFilter(includeProperties, {
                            expandDependents: true,
                            maxElements: 1000,
                            maxRecursion: 1,
                        }),
                    },
                ],
            });
            return textResult(result);
        }
        catch (error) {
            return errorResult("Failed to retrieve CEWS object", error);
        }
    });
    server.registerTool("cews_update_folder_security", {
        description: "Replaces the stored ACL of a FileNet Folder through native CEWS ExecuteChanges. " +
            "This tool does not use GraphQL. Supply the complete stored ACL. " +
            "Parent-inherited permissions are not stored on the child and should normally be omitted so inheritance remains intact.",
        inputSchema: z.object({
            repositoryId: z.string().default("ECM"),
            objectId: z.string().describe("Folder GUID, including braces."),
            updateSequenceNumber: z.number().int().optional().describe("Optional CE update sequence number for optimistic concurrency."),
            permissions: z
                .array(accessPermissionInput)
                .min(1)
                .describe("Complete stored ACL to replace on the folder."),
        }),
    }, async ({ repositoryId, objectId, updateSequenceNumber, permissions }) => {
        try {
            const xml = buildFolderSecurityChangesXml({
                repositoryId,
                objectId,
                updateSequenceNumber,
                permissions: permissions.map((permission) => ({
                    granteeName: permission.subAccessPermission.granteeName,
                    accessType: permission.subAccessPermission.accessType,
                    accessMask: permission.accessMask,
                    inheritableDepth: normalizeInheritableDepth(permission.inheritableDepth),
                })),
            });
            const result = await executeCews("ExecuteChanges", { _xml: xml });
            return textResult(result);
        }
        catch (error) {
            return errorResult("Failed to update folder security through CEWS", error);
        }
    });
    server.registerTool("cews_create_document", {
        description: "Creates one major-version text Document through native CEWS ExecuteChanges and files it into a Folder. " +
            "This tool does not use GraphQL and is intended for the FileNet security-migration POC.",
        inputSchema: z.object({
            repositoryId: z.string().default("ECM"),
            objectStoreId: z
                .string()
                .describe("Object store GUID, for example {5AEB2C81-DFED-45B3-A2F4-50B3C375E1E5}."),
            folderId: z.string().describe("Destination Folder GUID, including braces."),
            documentClass: z.string().default("Document"),
            documentTitle: z.string().min(1).describe("Document title and generated retrieval name."),
            contentText: z.string().default("FileNet CEWS POC document."),
            contentType: z.string().default("text/plain"),
        }),
    }, async ({ repositoryId, objectStoreId, folderId, documentClass, documentTitle, contentText, contentType }) => {
        let documentId;
        try {
            const createXml = buildCreateTextDocumentChangesXml({
                repositoryId,
                objectStoreId,
                documentClass,
                documentTitle,
                contentText,
                contentType,
            });
            const createResult = await executeCews("ExecuteChanges", { _xml: createXml });
            documentId = extractFirstObjectId(createResult);
            if (!documentId) {
                throw new Error("Document creation returned no document objectId, so filing was not attempted. " +
                    `CEWS response: ${stringifyForMcp(createResult)}`);
            }
            const containmentXml = buildCreateDynamicContainmentChangesXml({
                repositoryId,
                objectStoreId,
                documentId,
                folderId,
                containmentName: documentTitle,
            });
            try {
                const containmentResult = await executeCews("ExecuteChanges", { _xml: containmentXml });
                return textResult({ documentId, createResult, containmentResult });
            }
            catch (error) {
                return errorResult(`Document ${documentId} was created, but filing it into folder ${folderId} failed. ` +
                    "Do not retry blindly; retrieve this document before attempting another action.", error);
            }
        }
        catch (error) {
            return errorResult("Failed to create document through CEWS", error);
        }
    });
}
