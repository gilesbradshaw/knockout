// For certain common events (currently just 'click'), allow a simplified data-binding syntax
// e.g. click:handler instead of the usual full-length event:{click:handler}
var eventHandlersWithShortcuts = ['click'];
ko.utils.arrayForEach(eventHandlersWithShortcuts, function(eventName) {
    ko.bindingHandlers[eventName] = {
        'init': function(element, valueAccessor, allBindingsAccessor, viewModel) {
            var newValueAccessor = function () {
                var result = {};
                result[eventName] = valueAccessor();
                return result;
            };
            return ko.bindingHandlers['event']['init'].call(this, element, newValueAccessor, allBindingsAccessor, viewModel);
        }
    }
});


ko.bindingHandlers['event'] = {
    'init' : function (element, valueAccessor, allBindingsAccessor, viewModel) {
        var eventsToHandle = valueAccessor() || {};
        for(var eventNameOutsideClosure in eventsToHandle) {
            (function() {
                var eventName = eventNameOutsideClosure; // Separate variable to be captured by event handler closure
                if (typeof eventName == "string") {
                    ko.utils.registerEventHandler(element, eventName, function (event) {
                        var handlerReturnValue;
                        var handlerFunction = valueAccessor()[eventName];
                        if (!handlerFunction)
                            return;
                        
                        try { 
                            // Take all the event args, and prefix with the viewmodel
                            var argsForHandler = ko.utils.makeArray(arguments);
                            argsForHandler.unshift(viewModel);
                            handlerReturnValue = handlerFunction.apply(viewModel, argsForHandler);
                        } finally {
                            if (handlerReturnValue !== true) { // Normally we want to prevent default action. Developer can override this be explicitly returning true.
                                if (event.preventDefault)
                                    event.preventDefault();
                                else
                                    event.returnValue = false;
                            }
                        }

                        var bubble = allBindingsAccessor(eventName + 'Bubble') !== false;
                        if (!bubble) {
                            event.cancelBubble = true;
                            if (event.stopPropagation)
                                event.stopPropagation();
                        }
                    });
                }
            })();
        }
    }
};

ko.bindingHandlers['submit'] = {
    'init': function (element, valueAccessor, allBindingsAccessor, viewModel) {
        if (typeof valueAccessor() != "function")
            throw new Error("The value for a submit binding must be a function");
        ko.utils.registerEventHandler(element, "submit", function (event) {
            var handlerReturnValue;
            var value = valueAccessor();
            try { handlerReturnValue = value.call(viewModel, element); }
            finally {
                if (handlerReturnValue !== true) { // Normally we want to prevent default action. Developer can override this be explicitly returning true.
                    if (event.preventDefault)
                        event.preventDefault();
                    else
                        event.returnValue = false;
                }
            }
        });
    }
};

ko.bindingHandlers['visible'] = {
    'update': function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());
        var isCurrentlyVisible = !(element.style.display == "none");
        if (value && !isCurrentlyVisible)
            element.style.display = "";
        else if ((!value) && isCurrentlyVisible)
            element.style.display = "none";
    }
}

ko.bindingHandlers['enable'] = {
    'update': function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());
        if (value && element.disabled)
            element.removeAttribute("disabled");
        else if ((!value) && (!element.disabled))
            element.disabled = true;
    }
};

ko.bindingHandlers['disable'] = {
    'update': function (element, valueAccessor) {
        ko.bindingHandlers['enable']['update'](element, function() { return !ko.utils.unwrapObservable(valueAccessor()) });
    }
};

ko.bindingHandlers['value'] = {
    'init': function (element, valueAccessor, allBindingsAccessor) {
        // Always catch "change" event; possibly other events too if asked
        var eventsToCatch = ["change"];
        var requestedEventsToCatch = allBindingsAccessor("valueUpdate");
        if (requestedEventsToCatch) {
            if (typeof requestedEventsToCatch == "string") // Allow both individual event names, and arrays of event names
                requestedEventsToCatch = [requestedEventsToCatch];
            ko.utils.arrayPushAll(eventsToCatch, requestedEventsToCatch);
            eventsToCatch = ko.utils.arrayGetDistinctValues(eventsToCatch);
        }

        ko.utils.arrayForEach(eventsToCatch, function(eventName) {
            // The syntax "after<eventname>" means "run the handler asynchronously after the event"
            // This is useful, for example, to catch "keydown" events after the browser has updated the control
            // (otherwise, ko.selectExtensions.readValue(this) will receive the control's value *before* the key event)
            var handleEventAsynchronously = false;
            if (ko.utils.stringStartsWith(eventName, "after")) {
                handleEventAsynchronously = true;
                eventName = eventName.substring("after".length);
            }
            var runEventHandler = handleEventAsynchronously ? function(handler) { setTimeout(handler, 0) }
                                                            : function(handler) { handler() };

            ko.utils.registerEventHandler(element, eventName, function () {
                runEventHandler(function() {
                    var modelValue = valueAccessor();
                    var elementValue = ko.selectExtensions.readValue(element);
                    if (ko.isWriteableObservable(modelValue))
                        modelValue(elementValue);
                    else {
                        var propWriters = allBindingsAccessor('_ko_property_writers');
                        if (propWriters && propWriters['value'])
                            propWriters['value'](elementValue);
                    }
                });
            });
        });
    },
    'update': function (element, valueAccessor, allBindingsAccessor) {
        var valueIsSelectOption = element.tagName == "SELECT";

        // For SELECT elements, make sure value gets updated if the options are updated
        if (valueIsSelectOption) {
            allBindingsAccessor('options');
        }

        var newValue = ko.utils.unwrapObservable(valueAccessor());
        var elementValue = ko.selectExtensions.readValue(element);
        var valueHasChanged = (newValue != elementValue);

        // JavaScript's 0 == "" behavious is unfortunate here as it prevents writing 0 to an empty text box (loose equality suggests the values are the same).
        // We don't want to do a strict equality comparison as that is more confusing for developers in certain cases, so we specifically special case 0 != "" here.
        if ((newValue === 0) && (elementValue !== 0) && (elementValue !== "0"))
            valueHasChanged = true;

        // If a SELECT element has a caption, both no selection and caption selection will evaluate to
        // undefined. Make sure the caption is selected if the new value is undefined.
        if (valueIsSelectOption && !valueHasChanged && newValue === undefined && element.selectedIndex === -1)
            valueHasChanged = true;

        if (valueHasChanged) {
            var applyValueAction = function () { ko.selectExtensions.writeValue(element, newValue); };
            applyValueAction();

            // Workaround for IE6 bug: It won't reliably apply values to SELECT nodes during the same execution thread
            // right after you've changed the set of OPTION nodes on it. So for that node type, we'll schedule a second thread
            // to apply the value as well.
            if (valueIsSelectOption) {
                // If you try to set a model value that can't be represented in an already-populated dropdown, reject that change,
                // because you're not allowed to have a model value that disagrees with a visible UI selection.
                if (valueIsSelectOption && newValue !== ko.selectExtensions.readValue(element)) {
                    ko.utils.triggerEvent(element, "change");
                }
                newValue = ko.utils.unwrapObservable(valueAccessor());
                setTimeout(applyValueAction, 0);
            }
        }
    }
};

ko.bindingHandlers['options'] = {
    'update': function (element, valueAccessor, allBindingsAccessor) {
        if (element.tagName != "SELECT")
            throw new Error("options binding applies only to SELECT elements");

        var selectWasPreviouslyEmpty = element.length == 0;
        var previousSelectedValues = ko.utils.arrayMap(ko.utils.arrayFilter(element.childNodes, function (node) {
            return node.tagName && node.tagName == "OPTION" && node.selected;
        }), function (node) {
            return ko.selectExtensions.readValue(node) || node.innerText || node.textContent;
        });
        var previousScrollTop = element.scrollTop;
        element.scrollTop = 0; // Workaround for a Chrome rendering bug. Note that we restore the scroll position later. (https://github.com/SteveSanderson/knockout/issues/215)

        var value = ko.utils.unwrapObservable(valueAccessor());
        var selectedValue = element.value;

        // Remove all existing <option>s.
        // Need to use .remove() rather than .removeChild() for <option>s otherwise IE behaves oddly (https://github.com/SteveSanderson/knockout/issues/134)
        while (element.length > 0) {
            ko.cleanNode(element.options[0]);
            element.remove(0);
        }

        if (value) {
            if (typeof value.length != "number")
                value = [value];
            if (allBindingsAccessor('optionsCaption')) {
                var option = document.createElement("OPTION");
                ko.utils.setHtml(option, allBindingsAccessor('optionsCaption'));
                ko.selectExtensions.writeValue(option, undefined);
                element.appendChild(option);
            }
            var optionsValueValue = allBindingsAccessor('optionsValue');
            var optionsTextValue = allBindingsAccessor('optionsText');
            for (var i = 0, j = value.length; i < j; i++) {
                var option = document.createElement("OPTION");

                // Apply a value to the option element
                var optionValue = typeof optionsValueValue == "string" ? value[i][optionsValueValue] : value[i];
                optionValue = ko.utils.unwrapObservable(optionValue);
                ko.selectExtensions.writeValue(option, optionValue);

                // Apply some text to the option element
                var optionText;
                if (typeof optionsTextValue == "function")
                    optionText = optionsTextValue(value[i]); // Given a function; run it against the data value
                else if (typeof optionsTextValue == "string")
                    optionText = value[i][optionsTextValue]; // Given a string; treat it as a property name on the data value
                else
                    optionText = optionValue;				 // Given no optionsText arg; use the data value itself
                if ((optionText === null) || (optionText === undefined))
                    optionText = "";                                    

                ko.utils.setTextContent(option, optionText);

                element.appendChild(option);
            }

            // IE6 doesn't like us to assign selection to OPTION nodes before they're added to the document.
            // That's why we first added them without selection. Now it's time to set the selection.
            var newOptions = element.getElementsByTagName("OPTION");
            var countSelectionsRetained = 0;
            for (var i = 0, j = newOptions.length; i < j; i++) {
                if (ko.utils.arrayIndexOf(previousSelectedValues, ko.selectExtensions.readValue(newOptions[i])) >= 0) {
                    ko.utils.setOptionNodeSelectionState(newOptions[i], true);
                    countSelectionsRetained++;
                }
            }

            if (previousScrollTop)
                element.scrollTop = previousScrollTop;
        }
    }
};
ko.bindingHandlers['options'].optionValueDomDataKey = '__ko.optionValueDomData__';

ko.bindingHandlers['selectedOptions'] = {
    getSelectedValuesFromSelectNode: function (selectNode) {
        var result = [];
        var nodes = selectNode.childNodes;
        for (var i = 0, j = nodes.length; i < j; i++) {
            var node = nodes[i];
            if ((node.tagName == "OPTION") && node.selected)
                result.push(ko.selectExtensions.readValue(node));
        }
        return result;
    },
    'init': function (element, valueAccessor, allBindingsAccessor) {
        ko.utils.registerEventHandler(element, "change", function () {
            var value = valueAccessor();
            if (ko.isWriteableObservable(value))
                value(ko.bindingHandlers['selectedOptions'].getSelectedValuesFromSelectNode(this));
            else {
                var propWriters = allBindingsAccessor('_ko_property_writers');
                if (propWriters && propWriters['value'])
                    propWriters['value'](ko.bindingHandlers['selectedOptions'].getSelectedValuesFromSelectNode(this));
            }
        });
    },
    'update': function (element, valueAccessor, allBindingsAccessor) {
        if (element.tagName != "SELECT")
            throw new Error("values binding applies only to SELECT elements");

        // make sure options are updated first (and set dependency on options binding)
        allBindingsAccessor('options');

        var newValue = ko.utils.unwrapObservable(valueAccessor());
        if (newValue && typeof newValue.length == "number") {
            var nodes = element.childNodes;
            for (var i = 0, j = nodes.length; i < j; i++) {
                var node = nodes[i];
                if (node.tagName == "OPTION")
                    ko.utils.setOptionNodeSelectionState(node, ko.utils.arrayIndexOf(newValue, ko.selectExtensions.readValue(node)) >= 0);
            }
        }
    }
};

ko.bindingHandlers['text'] = {
    'update': function (element, valueAccessor) {
        ko.utils.setTextContent(element, valueAccessor());
    }
};

ko.bindingHandlers['html'] = {
    'init': function() {
        // Prevent binding on the dynamically-injected HTML (as developers are unlikely to expect that, and it has security implications)
        return { 'controlsDescendantBindings': true };
    },
    'update': function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());
        ko.utils.setHtml(element, value);
    }
};

ko.bindingHandlers['css'] = {
    'update': function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor() || {});
        for (var className in value) {
            if (typeof className == "string") {
                var shouldHaveClass = ko.utils.unwrapObservable(value[className]);
                ko.utils.toggleDomNodeCssClass(element, className, shouldHaveClass);
            }
        }
    }
};

ko.bindingHandlers['style'] = {
    'update': function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor() || {});
        for (var styleName in value) {
            if (typeof styleName == "string") {
                var styleValue = ko.utils.unwrapObservable(value[styleName]);
                element.style[styleName] = styleValue || ""; // Empty string removes the value, whereas null/undefined have no effect
            }
        }
    }
};

ko.bindingHandlers['uniqueName'] = {
    'init': function (element, valueAccessor) {
        if (valueAccessor()) {
            element.name = "ko_unique_" + (++ko.bindingHandlers['uniqueName'].currentIndex);

            // Workaround IE 6/7 issue
            // - https://github.com/SteveSanderson/knockout/issues/197
            // - http://www.matts411.com/post/setting_the_name_attribute_in_ie_dom/
            if (ko.utils.isIe6 || ko.utils.isIe7)
                element.mergeAttributes(document.createElement("<input name='" + element.name + "'/>"), false);
        }
    }
};
ko.bindingHandlers['uniqueName'].currentIndex = 0;

ko.bindingHandlers['checked'] = {
    'init': function (element, valueAccessor, allBindingsAccessor) {
        var updateHandler = function() {
            var valueToWrite;
            if (element.type == "checkbox") {
                valueToWrite = element.checked;
            } else if ((element.type == "radio") && (element.checked)) {
                valueToWrite = element.value;
            } else {
                return; // "checked" binding only responds to checkboxes and selected radio buttons
            }

            var modelValue = valueAccessor();
            if ((element.type == "checkbox") && (ko.utils.unwrapObservable(modelValue) instanceof Array)) {
                // For checkboxes bound to an array, we add/remove the checkbox value to that array
                // This works for both observable and non-observable arrays
                var existingEntryIndex = ko.utils.arrayIndexOf(ko.utils.unwrapObservable(modelValue), element.value);
                if (element.checked && (existingEntryIndex < 0))
                    modelValue.push(element.value);
                else if ((!element.checked) && (existingEntryIndex >= 0))
                    modelValue.splice(existingEntryIndex, 1);
            } else if (ko.isWriteableObservable(modelValue)) {
                if (modelValue() !== valueToWrite) { // Suppress repeated events when there's nothing new to notify (some browsers raise them)
                    modelValue(valueToWrite);
                }
            } else {
                var propWriters = allBindingsAccessor('_ko_property_writers');
                if (propWriters && propWriters['checked']) {
                    propWriters['checked'](valueToWrite);
                }
            }
        };
        ko.utils.registerEventHandler(element, "click", updateHandler);

        // IE 6 won't allow radio buttons to be selected unless they have a name
        if ((element.type == "radio") && !element.name)
            ko.bindingHandlers['uniqueName']['init'](element, function() { return true });
    },
    'update': function (element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());

        if (element.type == "checkbox") {
            if (value instanceof Array) {
                // When bound to an array, the checkbox being checked represents its value being present in that array
                element.checked = ko.utils.arrayIndexOf(value, element.value) >= 0;
            } else {
                // When bound to anything other value (not an array), the checkbox being checked represents the value being trueish
                element.checked = value;
            }
        } else if (element.type == "radio") {
            element.checked = (element.value == value);
        }
    }
};

ko.bindingHandlers['attr'] = {
    'update': function(element, valueAccessor, allBindingsAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor()) || {};
        for (var attrName in value) {
            if (typeof attrName == "string") {
                var attrValue = ko.utils.unwrapObservable(value[attrName]);

                // To cover cases like "attr: { checked:someProp }", we want to remove the attribute entirely
                // when someProp is a "no value"-like value (strictly null, false, or undefined)
                // (because the absence of the "checked" attr is how to mark an element as not checked, etc.)
                if ((attrValue === false) || (attrValue === null) || (attrValue === undefined))
                    element.removeAttribute(attrName);
                else
                    element.setAttribute(attrName, attrValue.toString());
            }
        }
    }
};

ko.bindingHandlers['hasfocus'] = {
    'init': function(element, valueAccessor, allBindingsAccessor) {
        var writeValue = function(valueToWrite) {
            var modelValue = valueAccessor();
            if (valueToWrite == ko.utils.unwrapObservable(modelValue))
                return;

            if (ko.isWriteableObservable(modelValue))
                modelValue(valueToWrite);
            else {
                var propWriters = allBindingsAccessor('_ko_property_writers');
                if (propWriters && propWriters['hasfocus']) {
                    propWriters['hasfocus'](valueToWrite);
                }
            }
        };
        ko.utils.registerEventHandler(element, "focus", function() { writeValue(true) });
        ko.utils.registerEventHandler(element, "focusin", function() { writeValue(true) }); // For IE
        ko.utils.registerEventHandler(element, "blur",  function() { writeValue(false) });
        ko.utils.registerEventHandler(element, "focusout",  function() { writeValue(false) }); // For IE
    },
    'update': function(element, valueAccessor) {
        var value = ko.utils.unwrapObservable(valueAccessor());
        value ? element.focus() : element.blur();
        ko.utils.triggerEvent(element, value ? "focusin" : "focusout"); // For IE, which doesn't reliably fire "focus" or "blur" events synchronously
    }
};

ko.bindingHandlers['repeat'] = {
    'init': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        // initialize optional parameters
        var o = {repeatIndex:'$index', repeatData:'$item'};
        var repeatParam = ko.utils.unwrapObservable(valueAccessor());
        if (typeof repeatParam == 'object') {
            if ('index' in repeatParam) o.repeatIndex = repeatParam['index'];
            if ('item' in repeatParam) o.repeatData = repeatParam['item'];
            if ('bind' in repeatParam) o.repeatBind = repeatParam['bind'];
        }

        // Make a copy of the element node to be copied for each repetition
        o.cleanNode = element.cloneNode(true);
        // IE's cloneNode copies expando properties; remove them from the new node
        ko.utils.domData.clean(o.cleanNode);
        // Remove node's binding (not necessary but cleaner)
        o.cleanNode.removeAttribute('data-bind');

        // Original element node is just a placeholder; make it hidden and delete children
        element.style.display = "none";
        element.disabled = true;
        while (element.firstChild)
            element.removeChild(element.firstChild);

        // set up persistent data         
        o.allRepeatNodes = [];
        o.repeatUpdate = ko.observable();
        o.repeatArray = undefined;
        bindingContext['$repeatOptions'] = o;
        
        return { 'controlsDescendantBindings': true };
    },
    'update': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        var o = bindingContext['$repeatOptions'];
        var allRepeatNodes = o.allRepeatNodes;
        var parent = element.parentNode;
        
        var repeatCount = ko.utils.unwrapObservable(valueAccessor());
        if (typeof repeatCount == 'object') {
            if ('count' in repeatCount) {
                repeatCount = ko.utils.unwrapObservable(repeatCount['count']);
            } else if ('foreach' in repeatCount) {
                o.repeatArray = ko.utils.unwrapObservable(repeatCount['foreach']); 
                repeatCount = o.repeatArray['length'];
            }
        } 
        o.repeatUpdate.notifySubscribers();
            
        if (allRepeatNodes.length < repeatCount) {
            // Array is longer: add nodes to end (also initially populates nodes)
            var endNode = allRepeatNodes.length ? allRepeatNodes[allRepeatNodes.length-1] : element;
            var startInsert = allRepeatNodes.length; 
            for (var i = startInsert; i < repeatCount; i++) {
                var newNode = o.cleanNode.cloneNode(true);     
                if (endNode.nextSibling)
                    parent.insertBefore(newNode, endNode.nextSibling);
                else
                    parent.appendChild(newNode);    
                newNode.setAttribute('data-repeat-index', i);
                allRepeatNodes[i] = newNode;
                endNode = newNode;
            }
            // Apply bindings to inserted nodes
            for (i = startInsert; i < repeatCount; i++) {
                var newContext = ko.utils.extend(new ko.bindingContext(), bindingContext);
                delete newContext['$repeatOptions'];
                newContext[o.repeatIndex] = i;
                if (o.repeatArray) {
                    newContext[o.repeatData] = (function(index) { return function() {
                        o.repeatUpdate();   // for dependency tracking
                        return ko.utils.unwrapObservable(o.repeatArray[index]); 
                    }; })(i);
                }
                var shouldBindDescendants = true;
                if (o.repeatBind) {
                    var binding = ko.bindingProvider['instance']['parseBindingsString'](o.repeatBind, newContext);
                    shouldBindDescendants = ko.applyBindingsToNode(allRepeatNodes[i], binding, newContext).shouldBindDescendants;
                }
                if (shouldBindDescendants)
                    ko.applyBindingsToDescendants(newContext, allRepeatNodes[i]);
            }
        } else if (allRepeatNodes.length > repeatCount) {
            // Array is shorter: remove nodes from end
            while (allRepeatNodes.length > repeatCount) {
                ko.removeNode(allRepeatNodes.pop());
            }
        }
    }
};

// "with: someExpression" is equivalent to "template: { if: someExpression, data: someExpression }"
ko.bindingHandlers['with'] = {
    makeTemplateValueAccessor: function(valueAccessor) {
        return function() { var value = valueAccessor(); return { 'if': value, 'data': value, 'templateEngine': ko.nativeTemplateEngine.instance } };
    },
    'init': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['init'](element, ko.bindingHandlers['with'].makeTemplateValueAccessor(valueAccessor));
    },
    'update': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['update'](element, ko.bindingHandlers['with'].makeTemplateValueAccessor(valueAccessor), allBindingsAccessor, viewModel, bindingContext);
    }
};
ko.jsonExpressionRewriting.bindingRewriteValidators['with'] = false; // Can't rewrite control flow bindings
ko.virtualElements.allowedBindings['with'] = true;

// "if: someExpression" is equivalent to "template: { if: someExpression }"
ko.bindingHandlers['if'] = {
    makeTemplateValueAccessor: function(valueAccessor) {
        return function() { return { 'if': valueAccessor(), 'templateEngine': ko.nativeTemplateEngine.instance } };
    },
    'init': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['init'](element, ko.bindingHandlers['if'].makeTemplateValueAccessor(valueAccessor));
    },
    'update': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['update'](element, ko.bindingHandlers['if'].makeTemplateValueAccessor(valueAccessor), allBindingsAccessor, viewModel, bindingContext);
    }
};
ko.jsonExpressionRewriting.bindingRewriteValidators['if'] = false; // Can't rewrite control flow bindings
ko.virtualElements.allowedBindings['if'] = true;

// "ifnot: someExpression" is equivalent to "template: { ifnot: someExpression }"
ko.bindingHandlers['ifnot'] = {
    makeTemplateValueAccessor: function(valueAccessor) {
        return function() { return { 'ifnot': valueAccessor(), 'templateEngine': ko.nativeTemplateEngine.instance } };
    },
    'init': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['init'](element, ko.bindingHandlers['ifnot'].makeTemplateValueAccessor(valueAccessor));
    },
    'update': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['update'](element, ko.bindingHandlers['ifnot'].makeTemplateValueAccessor(valueAccessor), allBindingsAccessor, viewModel, bindingContext);
    }
};
ko.jsonExpressionRewriting.bindingRewriteValidators['ifnot'] = false; // Can't rewrite control flow bindings
ko.virtualElements.allowedBindings['ifnot'] = true;

// "foreach: someExpression" is equivalent to "template: { foreach: someExpression }"
// "foreach: { data: someExpression, afterAdd: myfn }" is equivalent to "template: { foreach: someExpression, afterAdd: myfn }"
ko.bindingHandlers['foreach'] = {
    makeTemplateValueAccessor: function(valueAccessor) {
        return function() {
            var bindingValue = valueAccessor();

            // If bindingValue is the array, just pass it on its own
            if ((!bindingValue) || typeof bindingValue.length == "number")
                return { 'foreach': bindingValue, 'templateEngine': ko.nativeTemplateEngine.instance };

            // If bindingValue.data is the array, preserve all relevant options
            return {
                'foreach': bindingValue['data'],
                'comparer': bindingValue['comparer'],
                'includeDestroyed': bindingValue['includeDestroyed'],
                'afterAdd': bindingValue['afterAdd'],
                'beforeRemove': bindingValue['beforeRemove'],
                'afterRender': bindingValue['afterRender'],
                'templateEngine': ko.nativeTemplateEngine.instance
            };
        };
    },
    'init': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['init'](element, ko.bindingHandlers['foreach'].makeTemplateValueAccessor(valueAccessor));
    },
    'update': function(element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
        return ko.bindingHandlers['template']['update'](element, ko.bindingHandlers['foreach'].makeTemplateValueAccessor(valueAccessor), allBindingsAccessor, viewModel, bindingContext);
    }
};
ko.jsonExpressionRewriting.bindingRewriteValidators['foreach'] = false; // Can't rewrite control flow bindings
ko.virtualElements.allowedBindings['foreach'] = true;
ko.exportSymbol('ko.allowedVirtualElementBindings', ko.virtualElements.allowedBindings);