
ko.utils.domData = new (function () {
    var uniqueId = 0;
    var dataStoreKeyExpandoPropertyName = "__ko__" + (new Date).getTime();
    var dataStore = {};

    function getData(node, key) {
        var allDataForNode = getAll(node, false);
        return allDataForNode === undefined ? undefined : allDataForNode[key];
    }

    function setData(node, key, value) {
        if (value === undefined) {
            // Make sure we don't actually create a new domData key if we are actually deleting a value
            if (getAll(node, false) === undefined)
                return;
        }
        var allDataForNode = getAll(node, true);
        allDataForNode[key] = value;
    }

    function getAll(node, createIfNotFound) {
        var dataStoreKey = node[dataStoreKeyExpandoPropertyName];
        var hasExistingDataStore = dataStoreKey && (dataStoreKey !== "null");
        if (!hasExistingDataStore) {
            if (!createIfNotFound)
                return undefined;
            dataStoreKey = node[dataStoreKeyExpandoPropertyName] = "ko" + uniqueId++;
            dataStore[dataStoreKey] = {};
        }
        return dataStore[dataStoreKey];
    }

    function clear(node) {
        var dataStoreKey = node[dataStoreKeyExpandoPropertyName];
        if (dataStoreKey) {
            delete dataStore[dataStoreKey];
            node[dataStoreKeyExpandoPropertyName] = null;
        }
    }
    
    function nextKey() {
        return uniqueId++;
    }

    // add shortcuts
    ko.domDataGet = getData;
    ko.domDataSet = setData;

    return {
        get: getData,
        set: setData,
        clear: clear,
        nextKey: nextKey
    };
})();
ko.exportSymbol('utils.domData', ko.utils.domData);
ko.exportSymbol('utils.domData.clear', ko.utils.domData.clear); // Exporting only so specs can clear up after themselves fully