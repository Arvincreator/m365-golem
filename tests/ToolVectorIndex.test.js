const ToolVectorIndex = require('../src/managers/ToolVectorIndex');

function fixture() {
    const index = new ToolVectorIndex('synthetic-unused', { embedQuery: jest.fn().mockResolvedValue([1, 0]) });
    index.init = jest.fn().mockResolvedValue();
    const query = { distanceType: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), toArray: jest.fn().mockResolvedValue([{id:'capability/local-authoring', _distance:0.2}]) };
    index._table = { vectorSearch: jest.fn().mockReturnValue(query) };
    return { index, query };
}

test('uses cosine distance for threshold-compatible semantic scores', async () => {
    const { index, query } = fixture();
    const result = await index.search('synthetic', {throwOnError:true});
    expect(query.distanceType).toHaveBeenCalledWith('cosine');
    expect(result[0].score).toBeCloseTo(0.8);
});

test('distinguishes an empty index from a successful search', async () => {
    const { index } = fixture(); index._table = null;
    await expect(index.search('synthetic', {throwOnError:true})).rejects.toMatchObject({code:'VECTOR_INDEX_EMPTY'});
    await expect(index.search('synthetic')).resolves.toEqual([]);
});

test('lets the router observe vector failures rather than silently claiming zero matches', async () => {
    const { index, query } = fixture(); query.toArray.mockRejectedValue(new Error('synthetic failure'));
    await expect(index.search('synthetic', {throwOnError:true})).rejects.toThrow('synthetic failure');
});

test('reserves capability recall even when ordinary top results are other tools', async () => {
    const { index, query } = fixture();
    query.where = jest.fn().mockReturnThis();
    query.toArray.mockResolvedValueOnce([{id:'mcp/search',kind:'mcp',_distance:0.1}])
        .mockResolvedValueOnce([{id:'capability/local-authoring',kind:'capability',_distance:0.3}]);
    const result = await index.search('synthetic',{limit:1,includeCapabilities:true,throwOnError:true});
    expect(query.where).toHaveBeenCalledWith("kind = 'capability'");
    expect(result.map(item=>item.id)).toEqual(['mcp/search','capability/local-authoring']);
});
