const MCPToolCatalog = require('../src/mcp/MCPToolCatalog');

describe('MCPToolCatalog', () => {
    test('builds action examples from input schema required fields', () => {
        const example = MCPToolCatalog.buildActionExample('github', 'create_issue', {
            type: 'object',
            required: ['repository_full_name', 'title'],
            properties: {
                repository_full_name: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
            },
        });

        expect(example).toEqual({
            action: 'mcp_call',
            server: 'github',
            tool: 'create_issue',
            parameters: {
                repository_full_name: 'owner/repo',
                title: 'Title',
            },
        });
    });

    test('normalizes cached MCP tools into a catalog', () => {
        const catalog = MCPToolCatalog.buildCatalog([
            {
                name: 'demo',
                enabled: true,
                cachedTools: [
                    {
                        name: 'search',
                        description: 'Search records',
                        inputSchema: {
                            type: 'object',
                            required: ['query'],
                            properties: { query: { type: 'string' } },
                        },
                    },
                ],
            },
        ]);

        expect(catalog.tools).toHaveLength(1);
        expect(catalog.tools[0].id).toBe('demo/search');
        expect(catalog.tools[0].example.parameters.query).toBe('search query');
    });

    test('builds a usable nested example for structured MCP parameters', () => {
        const example = MCPToolCatalog.buildActionExample('documents', 'create_word', {
            type: 'object',
            required: ['outputPath', 'blocks'],
            properties: {
                outputPath: { type: 'string' },
                blocks: {
                    type: 'array',
                    items: {
                        anyOf: [{
                            type: 'object',
                            required: ['type', 'text'],
                            properties: {
                                type: { type: 'string', const: 'title' },
                                text: { type: 'string' },
                            },
                        }],
                    },
                },
            },
        });

        expect(example.parameters.blocks).toEqual([{ type: 'title', text: 'Text content' }]);
    });
});
