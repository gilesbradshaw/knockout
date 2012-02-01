/** @const */ var
    // Two-way bindings initialliy write to the DOM from the model,
    // but also will update the model property if the DOM changes
    bindingFlags_twoWay=01,
    // Event handler bindings call the given function in response to an event
    bindingFlags_eventHandler=02,
    // Content-bind bindings are responsible for binding (or not) their contents
    bindingFlags_contentBind=04,
    // Content-set bindings erase or set their contents
    bindingFlags_contentSet=010,
    // Content-update bindings modify their contents after the content nodes bindings have run
    bindingFlags_contentUpdate=020,
    // No-value bindings don't require a value (default value is true)
    bindingFlags_noValue=040,
    // Two-level bindings are like {attr.href: value} or {attr: {href: value}}
    bindingFlags_twoLevel=0100,
    // Virtual element bindings can be used in comments: <!-- ko if: value --><!-- /ko -->
    bindingFlags_canUseVirtual=0200
;

(function () {
    ko.bindingHandlers = {};

    ko.bindingContext = function(dataItem, parent) {
        var self = this, isOb = ko.isObservable(dataItem) || typeof(dataItem) == "function";
        self._subscription = null;  // set so it isn't set by merge call below
        self._subscription = ko.dependentObservable(parent ?
            function() {
                if (parent._subscription)
                    ko.dependencyDetection.registerDependency(parent._subscription);
                // set our properties
                self['$parents'] = (parent['$parents'] || []).slice(0);
                self['$parents'].unshift(self['$parent'] = parent['$data']);
                self['$data'] = isOb ? dataItem() : dataItem;
                // copy $root and any custom properties from parent binding context
                ko.utils.merge(self, parent);
            } :
            function() {
                self['$parents'] = [];
                self['$root'] = self['$data'] = isOb ? dataItem() : dataItem;
            }
        );
        if (!self._subscription.getDependenciesCount())
            self._subscription = null;
    }
    ko.bindingContext.prototype['createChildContext'] = function (dataItem) {
        return new ko.bindingContext(dataItem, this);
    };

    ko.bindingFlags = {
        'twoWay': bindingFlags_twoWay,
        'eventHandler': bindingFlags_eventHandler,
        'contentBind': bindingFlags_contentBind,
        'contentSet': bindingFlags_contentSet,
        'contentUpdate': bindingFlags_contentUpdate,
        'noValue': bindingFlags_noValue,
        'twoLevel': bindingFlags_twoLevel,
        'canUseVirtual': bindingFlags_canUseVirtual
    };

    ko.getBindingHandler = function(bindingName) {
        return ko.bindingHandlers[bindingName];
    }

    ko.checkBindingFlags = function(binding, flagsSet, flagsUnset) {
        return (!flagsSet || (binding['flags'] & flagsSet)) && !(binding['flags'] & flagsUnset);
    };

    function applyBindingsToDescendantsInternal (bindingContext, elementVerified, areRootNodesForBindingContext) {
        var currentChild, nextInQueue = ko.virtualElements.firstChild(elementVerified);
        while (currentChild = nextInQueue) {
            // Keep a record of the next child *before* applying bindings, in case the binding removes the current child from its position
            nextInQueue = ko.virtualElements.nextSibling(currentChild);
            applyBindingsToNodeAndDescendantsInternal(bindingContext, currentChild, areRootNodesForBindingContext);
        }
    }

    function applyBindingsToNodeAndDescendantsInternal (bindingContext, nodeVerified, isRootNodeForBindingContext) {
        var shouldBindDescendants = true;

        // Perf optimisation: Apply bindings only if...
        // (1) It's a root element for this binding context, as we will need to store the binding context on this node
        //     Note that we can't store binding contexts on non-elements (e.g., text nodes), as IE doesn't allow expando properties for those
        // (2) It might have bindings (e.g., it has a data-bind attribute, or it's a marker for a containerless template)
        var isElement = (nodeVerified.nodeType === 1);
        if (isElement) // Workaround IE <= 8 HTML parsing weirdness
            ko.virtualElements.normaliseVirtualElementDomStructure(nodeVerified);

        var shouldApplyBindings = (isElement && isRootNodeForBindingContext)                             // Case (1)
                               || ko.bindingProvider['instance']['nodeHasBindings'](nodeVerified);       // Case (2)
        if (shouldApplyBindings)
            shouldBindDescendants = applyBindingsToNodeInternal(nodeVerified, null, bindingContext, isRootNodeForBindingContext).shouldBindDescendants;

        if (shouldBindDescendants)
            applyBindingsToDescendantsInternal(bindingContext, nodeVerified, (!isElement && isRootNodeForBindingContext));
    }

    function applyBindingsToNodeInternal (node, bindings, bindingContext, isRootNodeForBindingContext) {
        // Need to be sure that inits are only run once, and updates never run until all the inits have been run
        var initPhase = 0; // 0 = before all inits, 1 = during inits, 2 = after all inits

        // Each time the dependentObservable is evaluated (after data changes),
        // the binding attribute is reparsed so that it can pick out the correct
        // model properties in the context of the changed data.
        // DOM event callbacks need to be able to access this changed data,
        // so we need a single parsedBindings variable (shared by all callbacks
        // associated with this node's bindings) that all the closures can access.
        var parsedBindings;
        function makeValueAccessor(bindingKey) {
            return function () { return parsedBindings[bindingKey] }
        }
        function parsedBindingsAccessor() {
            return parsedBindings;
        }

        // We only need to store the bindingContext at the root of the subtree where it applies
        // as all descendants will be able to find it by scanning up their ancestry
        if (isRootNodeForBindingContext)
            ko.storedBindingContextForNode(node, bindingContext);

        var bindingHandlerThatControlsDescendantBindings;
        ko.dependentObservable(
            function () {
                var viewModel = bindingContext['$data'];

                // Use evaluatedBindings if given, otherwise fall back on asking the bindings provider to give us some bindings
                var evaluatedBindings = (typeof bindings == "function") ? bindings() : bindings;
                parsedBindings = evaluatedBindings || ko.bindingProvider['instance']['getBindings'](node, bindingContext);

                if (parsedBindings) {
                    // If the context includes an subscription, add a dependency to it
                    if (bindingContext._subscription)
                        ko.dependencyDetection.registerDependency(bindingContext._subscription);

                    // First run all the inits, so bindings can register for notification on changes
                    if (initPhase === 0) {
                        initPhase = 1;
                        for (var bindingKey in parsedBindings) {
                            var binding = ko.getBindingHandler(bindingKey);
                            if (!binding)
                                continue;
                            if (node.nodeType === 8 && !(binding['flags'] & bindingFlags_canUseVirtual))
                                throw new Error("The binding '" + bindingKey + "' cannot be used with virtual elements");

                            if (typeof binding["init"] == "function") {
                                binding["init"](node, makeValueAccessor(bindingKey), parsedBindingsAccessor, viewModel, bindingContext);
                            }
                            if (binding['flags'] & bindingFlags_contentBind) {
                                // If this binding handler claims to control descendant bindings, make a note of this
                                if (bindingHandlerThatControlsDescendantBindings !== undefined)
                                    throw new Error("Multiple bindings (" + bindingHandlerThatControlsDescendantBindings + " and " + bindingKey + ") are trying to control descendant bindings of the same element. You cannot use these bindings together on the same element.");
                                bindingHandlerThatControlsDescendantBindings = bindingKey;
                            }
                        }
                        initPhase = 2;
                    }

                    // ... then run all the updates, which might trigger changes even on the first evaluation
                    if (initPhase === 2) {
                        for (var bindingKey in parsedBindings) {
                            var binding = ko.getBindingHandler(bindingKey);
                            if (binding && typeof binding["update"] == "function") {
                                binding["update"](node, makeValueAccessor(bindingKey), parsedBindingsAccessor, viewModel, bindingContext);
                            }
                        }
                    }
                }
            },
            null,
            { disposeWhenNodeIsRemoved : node }
        );

        return {
            shouldBindDescendants: bindingHandlerThatControlsDescendantBindings === undefined
        };
    };

    var storedBindingContextDomDataKey = "__ko_bindingContext__";
    ko.storedBindingContextForNode = function (node, bindingContext) {
        if (arguments.length == 2) {
            ko.utils.domData.set(node, storedBindingContextDomDataKey, bindingContext);
            if (bindingContext._subscription)
                bindingContext._subscription.addDisposeWhenNodeIsRemoved(node);
        }
        else
            return ko.utils.domData.get(node, storedBindingContextDomDataKey);
    }

    function getBindingContext(viewModelOrBindingContext) {
        return viewModelOrBindingContext && (viewModelOrBindingContext instanceof ko.bindingContext)
            ? viewModelOrBindingContext
            : new ko.bindingContext(viewModelOrBindingContext);
    }

    ko.applyBindingsToNode = function (node, bindings, viewModelOrBindingContext) {
        if (node.nodeType === 1) // If it's an element, workaround IE <= 8 HTML parsing weirdness
            ko.virtualElements.normaliseVirtualElementDomStructure(node);
        return applyBindingsToNodeInternal(node, bindings, getBindingContext(viewModelOrBindingContext), true);
    };

    ko.applyBindingsToDescendants = function(viewModelOrBindingContext, rootNode, areRootNodesForBindingContext) {
        if (rootNode.nodeType === 1 || rootNode.nodeType === 8)
            applyBindingsToDescendantsInternal(getBindingContext(viewModelOrBindingContext), rootNode, areRootNodesForBindingContext);
    };

    ko.applyBindings = function (viewModelOrBindingContext, rootNode) {
        if (rootNode && (rootNode.nodeType !== 1) && (rootNode.nodeType !== 8))
            throw new Error("ko.applyBindings: first parameter should be your view model; second parameter should be a DOM node");
        rootNode = rootNode || window.document.body; // Make "rootNode" parameter optional

        applyBindingsToNodeAndDescendantsInternal(getBindingContext(viewModelOrBindingContext), rootNode, true);
    };

    // Retrieving binding context from arbitrary nodes
    ko.contextFor = function(node) {
        // We can only do something meaningful for elements and comment nodes (in particular, not text nodes, as IE can't store domdata for them)
        switch (node.nodeType) {
            case 1:
            case 8:
                var context = ko.storedBindingContextForNode(node);
                if (context) return context;
                if (node.parentNode) return ko.contextFor(node.parentNode);
                break;
        }
        return undefined;
    };
    ko.dataFor = function(node) {
        var context = ko.contextFor(node);
        return context ? context['$data'] : undefined;
    };

    ko.exportSymbol('bindingHandlers', ko.bindingHandlers);
    ko.exportSymbol('bindingContext', ko.bindingContext);
    ko.exportSymbol('bindingFlags', ko.bindingFlags);
    ko.exportSymbol('applyBindings', ko.applyBindings);
    ko.exportSymbol('applyBindingsToDescendants', ko.applyBindingsToDescendants);
    ko.exportSymbol('applyBindingsToNode', ko.applyBindingsToNode);
    ko.exportSymbol('contextFor', ko.contextFor);
    ko.exportSymbol('dataFor', ko.dataFor);
})();