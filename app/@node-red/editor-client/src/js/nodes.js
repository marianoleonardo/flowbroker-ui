/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/
RED.nodes = (function() {

    var node_defs = {};
    var nodes = {};
    var nodeTabMap = {};
    var linkTabMap = {};

    var configNodes = {};
    var links = [];
    var nodeLinks = {};
    var defaultWorkspace;
    var workspaces = {};
    var workspacesOrder =[];
    var subflows = {};
    var loadedFlowVersion = null;

    var groups = {};
    var groupsByZ = {};

    var initialLoad;

    var dirty = false;

    function setDirty(d) {
        dirty = d;
        RED.events.emit("workspace:dirty",{dirty:dirty});
    }

    var registry = (function() {
        var moduleList = {};
        var nodeList = [];
        var nodeSets = {};
        var typeToId = {};
        var nodeDefinitions = {};
        var iconSets = {};

        nodeDefinitions['tab'] = {
            defaults: {
                label: {value:""},
                disabled: {value: false},
                info: {value: ""}
            }
        };


        var exports = {
            setModulePendingUpdated: function(module,version) {
                moduleList[module].pending_version = version;
                RED.events.emit("registry:module-updated",{module:module,version:version});
            },
            getModule: function(module) {
                return moduleList[module];
            },
            getNodeSetForType: function(nodeType) {
                return exports.getNodeSet(typeToId[nodeType]);
            },
            getModuleList: function() {
                return moduleList;
            },
            getNodeList: function() {
                return nodeList;
            },
            getNodeTypes: function() {
                return Object.keys(nodeDefinitions);
            },
            setNodeList: function(list) {
                nodeList = [];
                for(var i=0;i<list.length;i++) {
                    var ns = list[i];
                    exports.addNodeSet(ns);
                }
            },
            addNodeSet: function(ns) {
                if (!ns.types) {
                    // A node has been loaded without any types. Ignore it.
                    return;
                }
                ns.added = false;
                nodeSets[ns.id] = ns;
                for (var j=0;j<ns.types.length;j++) {
                    typeToId[ns.types[j]] = ns.id;
                }
                nodeList.push(ns);

                moduleList[ns.module] = moduleList[ns.module] || {
                    name:ns.module,
                    version:ns.version,
                    local:ns.local,
                    sets:{}
                };
                if (ns.pending_version) {
                    moduleList[ns.module].pending_version = ns.pending_version;
                }
                moduleList[ns.module].sets[ns.name] = ns;
                RED.events.emit("registry:node-set-added",ns);
            },
            removeNodeSet: function(id) {
                var ns = nodeSets[id];
                for (var j=0;j<ns.types.length;j++) {
                    delete typeToId[ns.types[j]];
                }
                delete nodeSets[id];
                for (var i=0;i<nodeList.length;i++) {
                    if (nodeList[i].id === id) {
                        nodeList.splice(i,1);
                        break;
                    }
                }
                delete moduleList[ns.module].sets[ns.name];
                if (Object.keys(moduleList[ns.module].sets).length === 0) {
                    delete moduleList[ns.module];
                }
                RED.events.emit("registry:node-set-removed",ns);
                return ns;
            },
            getNodeSet: function(id) {
                return nodeSets[id];
            },
            enableNodeSet: function(id) {
                var ns = nodeSets[id];
                ns.enabled = true;
                RED.events.emit("registry:node-set-enabled",ns);
            },
            disableNodeSet: function(id) {
                var ns = nodeSets[id];
                ns.enabled = false;
                RED.events.emit("registry:node-set-disabled",ns);
            },
            registerNodeType: function(nt,def) {
                nodeDefinitions[nt] = def;
                def.type = nt;
                if (nt.substring(0,8) != "subflow:") {
                    def.set = nodeSets[typeToId[nt]];
                    nodeSets[typeToId[nt]].added = true;
                    nodeSets[typeToId[nt]].enabled = true;

                    var ns;
                    if (def.set.module === "node-red") {
                        ns = "node-red";
                    } else {
                        ns = def.set.id;
                    }
                    def["_"] = function() {
                        var args = Array.prototype.slice.call(arguments, 0);
                        var original = args[0];
                        if (args[0].indexOf(":") === -1) {
                            args[0] = ns+":"+args[0];
                        }
                        var result = RED._.apply(null,args);
                        if (result === args[0]) {
                            result = original;
                        }
                        return result;
                    }

                    // TODO: too tightly coupled into palette UI
                }
                if (def.defaults) {
                    for (var d in def.defaults) {
                        if (def.defaults.hasOwnProperty(d)) {
                            if (def.defaults[d].type) {
                                try {
                                    def.defaults[d]._type = parseNodePropertyTypeString(def.defaults[d].type)
                                } catch(err) {
                                    console.warn(err);
                                }
                            }
                        }
                    }
                }


                RED.events.emit("registry:node-type-added",nt);
            },
            removeNodeType: function(nt) {
                if (nt.substring(0,8) != "subflow:") {
                    // NON-NLS - internal debug message
                    throw new Error("this api is subflow only. called with:",nt);
                }
                delete nodeDefinitions[nt];
                RED.events.emit("registry:node-type-removed",nt);
            },
            getNodeType: function(nt) {
                return nodeDefinitions[nt];
            },
            setIconSets: function(sets) {
                iconSets = sets;
                iconSets["font-awesome"] = RED.nodes.fontAwesome.getIconList();
            },
            getIconSets: function() {
                return iconSets;
            }
        };
        return exports;
    })();

    function getID() {
        var bytes = [];
        for (var i=0;i<8;i++) {
            bytes.push(Math.round(0xff*Math.random()).toString(16).padStart(2,'0'));
        }
        return bytes.join("");
    }

    function parseNodePropertyTypeString(typeString) {
        typeString = typeString.trim();
        var c;
        var pos = 0;
        var isArray = /\[\]$/.test(typeString);
        if (isArray) {
            typeString = typeString.substring(0,typeString.length-2);
        }

        var l = typeString.length;
        var inBrackets = false;
        var inToken = false;
        var currentToken = "";
        var types = [];
        while (pos < l) {
            c = typeString[pos];
            if (inToken) {
                if (c === "|") {
                    types.push(currentToken.trim())
                    currentToken = "";
                    inToken = false;
                } else if (c === ")") {
                    types.push(currentToken.trim())
                    currentToken = "";
                    inBrackets = false;
                    inToken = false;
                } else {
                    currentToken += c;
                }
            } else {
                if (c === "(") {
                    if (inBrackets) {
                        throw new Error("Invalid character '"+c+"' at position "+pos)
                    }
                    inBrackets = true;
                } else if (c !== " ") {
                    inToken = true;
                    currentToken = c;
                }
            }
            pos++;
        }
        currentToken = currentToken.trim();
        if (currentToken.length > 0) {
            types.push(currentToken)
        }
        return {
            types: types,
            array: isArray
        }
    }


    function addNode(n) {
        if (n.type.indexOf("subflow") !== 0) {
            n["_"] = n._def._;
        } else {
            var subflowId = n.type.substring(8);
            var sf = RED.nodes.subflow(subflowId);
            if (sf) {
                sf.instances.push(sf);
            }
            n["_"] = RED._;
        }
        if (n._def.category == "config") {
            configNodes[n.id] = n;
        } else {
            if (n.wires && (n.wires.length > n.outputs)) { n.outputs = n.wires.length; }
            n.dirty = true;
            updateConfigNodeUsers(n);
            if (n._def.category == "subflows" && typeof n.i === "undefined") {
                var nextId = 0;
                RED.nodes.eachNode(function(node) {
                    nextId = Math.max(nextId,node.i||0);
                });
                n.i = nextId+1;
            }
            nodes[n.id] = n;
            if (!nodeLinks[n.id]) {
                nodeLinks[n.id] = {in:[],out:[]};
            }
            if (nodeTabMap[n.z]) {
                nodeTabMap[n.z][n.id] = n;
            } else {
                console.warn("Node added to unknown tab/subflow:",n);
            }
        }
        RED.events.emit('nodes:add',n);
    }
    function addLink(l) {
        links.push(l);
        if (l.source) {
            // Possible the node hasn't been added yet
            if (!nodeLinks[l.source.id]) {
                nodeLinks[l.source.id] = {in:[],out:[]};
            }
            nodeLinks[l.source.id].out.push(l);
        }
        if (l.target) {
            if (!nodeLinks[l.target.id]) {
                nodeLinks[l.target.id] = {in:[],out:[]};
            }
            nodeLinks[l.target.id].in.push(l);
        }
        if (l.source.z === l.target.z && linkTabMap[l.source.z]) {
            linkTabMap[l.source.z].push(l);
        }
        RED.events.emit("links:add",l);
    }

    function getNode(id) {
        if (id in configNodes) {
            return configNodes[id];
        } else if (id in nodes) {
            return nodes[id];
        }
        return null;
    }

    function removeNode(id) {
        var removedLinks = [];
        var removedNodes = [];
        var node;
        if (id in configNodes) {
            node = configNodes[id];
            delete configNodes[id];
            RED.events.emit('nodes:remove',node);
            RED.workspaces.refresh();
        } else if (id in nodes) {
            node = nodes[id];
            delete nodes[id]
            delete nodeLinks[id];
            if (nodeTabMap[node.z]) {
                delete nodeTabMap[node.z][node.id];
            }
            removedLinks = links.filter(function(l) { return (l.source === node) || (l.target === node); });
            removedLinks.forEach(removeLink);
            var updatedConfigNode = false;
            for (var d in node._def.defaults) {
                if (node._def.defaults.hasOwnProperty(d)) {
                    var property = node._def.defaults[d];
                    if (property.type) {
                        var type = registry.getNodeType(property.type);
                        if (type && type.category == "config") {
                            var configNode = configNodes[node[d]];
                            if (configNode) {
                                updatedConfigNode = true;
                                if (configNode._def.exclusive) {
                                    removeNode(node[d]);
                                    removedNodes.push(configNode);
                                } else {
                                    var users = configNode.users;
                                    users.splice(users.indexOf(node),1);
                                    RED.events.emit('nodes:change',configNode)
                                }
                            }
                        }
                    }
                }
            }

            if (node.type.indexOf("subflow:") === 0) {
                var subflowId = node.type.substring(8);
                var sf = RED.nodes.subflow(subflowId);
                if (sf) {
                    sf.instances.splice(sf.instances.indexOf(node),1);
                }
            }

            if (updatedConfigNode) {
                RED.workspaces.refresh();
            }
            try {
                if (node._def.oneditdelete) {
                    node._def.oneditdelete.call(node);
                }
            } catch(err) {
                console.log("oneditdelete",node.id,node.type,err.toString());
            }
            RED.events.emit('nodes:remove',node);
        }



        if (node && node._def.onremove) {
            // Deprecated: never documented but used by some early nodes
            console.log("Deprecated API warning: node type ",node.type," has an onremove function - should be oneditremove - please report");
            node._def.onremove.call(n);
        }
        return {links:removedLinks,nodes:removedNodes};
    }

    function moveNodeToTab(node, z) {
        if (node.type === "group") {
            moveGroupToTab(node,z);
            return;
        }
        if (nodeTabMap[node.z]) {
            delete nodeTabMap[node.z][node.id];
        }
        if (!nodeTabMap[z]) {
            nodeTabMap[z] = {};
        }
        nodeTabMap[z][node.id] = node;
        var nl = nodeLinks[node.id];
        if (nl) {
            nl.in.forEach(function(l) {
                var idx = linkTabMap[node.z].indexOf(l);
                if (idx != -1) {
                    linkTabMap[node.z].splice(idx, 1);
                }
                if ((l.source.z === z) && linkTabMap[z]) {
                    linkTabMap[z].push(l);
                }
            });
            nl.out.forEach(function(l) {
                var idx = linkTabMap[node.z].indexOf(l);
                if (idx != -1) {
                    linkTabMap[node.z].splice(idx, 1);
                }
                if ((l.target.z === z) && linkTabMap[z]) {
                    linkTabMap[z].push(l);
                }
            });
        }
        node.z = z;
        RED.events.emit("nodes:change",node);
    }
    function moveGroupToTab(group, z) {
        var index = groupsByZ[group.z].indexOf(group);
        groupsByZ[group.z].splice(index,1);
        groupsByZ[z] = groupsByZ[z] || [];
        groupsByZ[z].push(group);
        group.z = z;
        RED.events.emit("groups:change",group);
    }

    function removeLink(l) {
        var index = links.indexOf(l);
        if (index != -1) {
            links.splice(index,1);
            if (l.source && nodeLinks[l.source.id]) {
                var sIndex = nodeLinks[l.source.id].out.indexOf(l)
                if (sIndex !== -1) {
                    nodeLinks[l.source.id].out.splice(sIndex,1)
                }
            }
            if (l.target && nodeLinks[l.target.id]) {
                var tIndex = nodeLinks[l.target.id].in.indexOf(l)
                if (tIndex !== -1) {
                    nodeLinks[l.target.id].in.splice(tIndex,1)
                }
            }
            if (l.source.z === l.target.z && linkTabMap[l.source.z]) {
                index = linkTabMap[l.source.z].indexOf(l);
                if (index !== -1) {
                    linkTabMap[l.source.z].splice(index,1)
                }
            }
        }
        RED.events.emit("links:remove",l);
    }

    function addWorkspace(ws,targetIndex) {
        workspaces[ws.id] = ws;
        nodeTabMap[ws.id] = {};
        linkTabMap[ws.id] = [];

        ws._def = RED.nodes.getType('tab');
        if (targetIndex === undefined) {
            workspacesOrder.push(ws.id);
        } else {
            workspacesOrder.splice(targetIndex,0,ws.id);
        }
        RED.events.emit('flows:add',ws);
        if (targetIndex !== undefined) {
            RED.events.emit('flows:reorder',workspacesOrder)
        }
    }
    function getWorkspace(id) {
        return workspaces[id];
    }
    function removeWorkspace(id) {
        var ws = workspaces[id];
        var removedNodes = [];
        var removedLinks = [];
        var removedGroups = [];
        if (ws) {
            delete workspaces[id];
            delete nodeTabMap[id];
            delete linkTabMap[id];
            workspacesOrder.splice(workspacesOrder.indexOf(id),1);
            var i;
            var node;
            // TODO: this should use nodeTabMap
            for (i in nodes) {
                if (nodes.hasOwnProperty(i)) {
                    node = nodes[i];
                    if (node.z == id) {
                        removedNodes.push(node);
                    }
                }
            }
            for(i in configNodes) {
                if (configNodes.hasOwnProperty(i)) {
                    node = configNodes[i];
                    if (node.z == id) {
                        removedNodes.push(node);
                    }
                }
            }

            for (i=0;i<removedNodes.length;i++) {
                var result = removeNode(removedNodes[i].id);
                removedLinks = removedLinks.concat(result.links);
            }

            // Must get 'removedGroups' in the right order.
            //  - start with the top-most groups
            //  - then recurse into them
            removedGroups = (groupsByZ[id] || []).filter(function(g) { return !g.g; });
            for (i=0;i<removedGroups.length;i++) {
                removedGroups[i].nodes.forEach(function(n) {
                    if (n.type === "group") {
                        removedGroups.push(n);
                    }
                });
            }
            // Now remove them in the reverse order
            for (i=removedGroups.length-1; i>=0; i--) {
                removeGroup(removedGroups[i]);
            }
            RED.events.emit('flows:remove',ws);
        }
        return {nodes:removedNodes,links:removedLinks, groups: removedGroups};
    }

    function addSubflow(sf, createNewIds) {
        if (createNewIds) {
            var subflowNames = Object.keys(subflows).map(function(sfid) {
                return subflows[sfid].name;
            });

            subflowNames.sort();
            var copyNumber = 1;
            var subflowName = sf.name;
            subflowNames.forEach(function(name) {
                if (subflowName == name) {
                    copyNumber++;
                    subflowName = sf.name+" ("+copyNumber+")";
                }
            });
            sf.name = subflowName;
        }
        subflows[sf.id] = sf;
        nodeTabMap[sf.id] = {};
        linkTabMap[sf.id] = [];

        RED.nodes.registerType("subflow:"+sf.id, {
            defaults:{
                name:{value:""},
                env:{value:[]}
            },
            icon: function() { return sf.icon||"subflow.svg" },
            category: sf.category || "subflows",
            inputs: sf.in.length,
            outputs: sf.out.length,
            color: sf.color || "#DDAA99",
            label: function() { return this.name||RED.nodes.subflow(sf.id).name },
            labelStyle: function() { return this.name?"red-ui-flow-node-label-italic":""; },
            paletteLabel: function() { return RED.nodes.subflow(sf.id).name },
            inputLabels: function(i) { return sf.inputLabels?sf.inputLabels[i]:null },
            outputLabels: function(i) { return sf.outputLabels?sf.outputLabels[i]:null },
            oneditprepare: function() {
                RED.subflow.buildEditForm("subflow",this);
                RED.subflow.buildPropertiesForm(this);
            },
            oneditresize: function(size) {
                // var rows = $(".dialog-form>div:not(.node-input-env-container-row)");
                var height = size.height;
                // for (var i=0; i<rows.size(); i++) {
                //     height -= $(rows[i]).outerHeight(true);
                // }
                // var editorRow = $("#dialog-form>div.node-input-env-container-row");
                // height -= (parseInt(editorRow.css("marginTop"))+parseInt(editorRow.css("marginBottom")));
                $("ol.red-ui-editor-subflow-env-list").editableList('height',height);
            },
            set:{
                module: "node-red"
            }
        });
        sf.instances = [];
        sf._def = RED.nodes.getType("subflow:"+sf.id);
        RED.events.emit("subflows:add",sf);
    }
    function getSubflow(id) {
        return subflows[id];
    }
    function removeSubflow(sf) {
        if (subflows[sf.id]) {
            delete subflows[sf.id];
            delete nodeTabMap[sf.id];
            registry.removeNodeType("subflow:"+sf.id);
            RED.events.emit("subflows:remove",sf);
        }
    }

    function subflowContains(sfid,nodeid) {
        for (var i in nodes) {
            if (nodes.hasOwnProperty(i)) {
                var node = nodes[i];
                if (node.z === sfid) {
                    var m = /^subflow:(.+)$/.exec(node.type);
                    if (m) {
                        if (m[1] === nodeid) {
                            return true;
                        } else {
                            var result = subflowContains(m[1],nodeid);
                            if (result) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    }

    function getAllDownstreamNodes(node) {
        return getAllFlowNodes(node,'down').filter(function(n) { return n !== node });
    }
    function getAllUpstreamNodes(node) {
        return getAllFlowNodes(node,'up').filter(function(n) { return n !== node });
    }
    function getAllFlowNodes(node, direction) {
        var selection = RED.view.selection();
        var visited = new Set();
        var nodes = [node];
        var initialNode = true;
        while(nodes.length > 0) {
            var n = nodes.shift();
            visited.add(n);
            var links = [];
            if (!initialNode || !direction || (initialNode && direction === 'up')) {
                links = links.concat(nodeLinks[n.id].in);
            }
            if (!initialNode || !direction || (initialNode && direction === 'down')) {
                links = links.concat(nodeLinks[n.id].out);
            }
            initialNode = false;
            links.forEach(function(l) {
                if (!visited.has(l.source)) {
                    nodes.push(l.source);
                }
                if (!visited.has(l.target)) {
                    nodes.push(l.target);
                }
            })
        }
        return Array.from(visited);
    }


    function convertWorkspace(n) {
        var node = {};
        node.id = n.id;
        node.type = n.type;
        for (var d in n._def.defaults) {
            if (n._def.defaults.hasOwnProperty(d)) {
                node[d] = n[d];
            }
        }
        return node;
    }
    /**
     * Converts a node to an exportable JSON Object
     **/
    function convertNode(n, opts) {
        var exportCreds = true;
        var exportDimensions = false;
        if (opts === false) {
            exportCreds = false;
        } else if (typeof opts === "object") {
            if (opts.hasOwnProperty("credentials")) {
                exportCreds = opts.credentials;
            }
            if (opts.hasOwnProperty("dimensions")) {
                exportDimensions = opts.dimensions;
            }
        }

        if (n.type === 'tab') {
            return convertWorkspace(n);
        }
        var node = {};
        node.id = n.id;
        node.type = n.type;
        node.z = n.z;
        if (node.z === 0 || node.z === "") {
            delete node.z;
        }
        if (n.d === true) {
            node.d = true;
        }
        if (n.g) {
            node.g = n.g;
        }
        if (node.type == "unknown") {
            for (var p in n._orig) {
                if (n._orig.hasOwnProperty(p)) {
                    node[p] = n._orig[p];
                }
            }
        } else {
            for (var d in n._def.defaults) {
                if (n._def.defaults.hasOwnProperty(d)) {
                    node[d] = n[d];
                }
            }
            if (exportCreds) {
                var credentialSet = {};
                if (/^subflow:/.test(node.type) && n.credentials) {
                    // A subflow instance node can have arbitrary creds
                    for (var sfCred in n.credentials) {
                        if (n.credentials.hasOwnProperty(sfCred)) {
                            if (!n.credentials._ ||
                                n.credentials["has_"+sfCred] != n.credentials._["has_"+sfCred] ||
                                (n.credentials["has_"+sfCred] && n.credentials[sfCred])) {
                                credentialSet[sfCred] = n.credentials[sfCred];
                            }
                        }
                    }
                } else if (n.credentials) {
                    node.credentials = {};
                    // All other nodes have a well-defined list of possible credentials
                    for (var cred in n._def.credentials) {
                        if (n._def.credentials.hasOwnProperty(cred)) {
                            if (n._def.credentials[cred].type == 'password') {
                                if (!n.credentials._ ||
                                    n.credentials["has_"+cred] != n.credentials._["has_"+cred] ||
                                    (n.credentials["has_"+cred] && n.credentials[cred])) {
                                    credentialSet[cred] = n.credentials[cred];
                                }
                            } else if (n.credentials[cred] != null && (!n.credentials._ || n.credentials[cred] != n.credentials._[cred])) {
                                credentialSet[cred] = n.credentials[cred];
                            }
                        }
                    }
                }
                if (Object.keys(credentialSet).length > 0) {
                    node.credentials = credentialSet;
                }
            }
        }
        if (n.type === "group") {
            node.x = n.x;
            node.y = n.y;
            node.w = n.w;
            node.h = n.h;
            // In 1.1.0, we have seen an instance of this array containing `undefined`
            // Until we know how that can happen, add a filter here to remove them
            node.nodes = node.nodes.filter(function(n) { return !!n }).map(function(n) { return n.id });
        }
        if (n._def.category != "config") {
            node.x = n.x;
            node.y = n.y;
            if (exportDimensions) {
                if (!n.hasOwnProperty('w')) {
                    // This node has not yet been drawn in the view. So we need
                    // to explicitly calculate its dimensions. Store the result
                    // on the node as if it had been drawn will save us doing
                    // it again
                    var dimensions = RED.view.calculateNodeDimensions(n);
                    n.w = dimensions[0];
                    n.h = dimensions[1];
                }
                node.w = n.w;
                node.h = n.h;
            }
            node.wires = [];
            for(var i=0;i<n.outputs;i++) {
                node.wires.push([]);
            }
            var wires = links.filter(function(d){return d.source === n;});
            for (var j=0;j<wires.length;j++) {
                var w = wires[j];
                if (w.target.type != "subflow") {
                    if (w.sourcePort < node.wires.length) {
                        node.wires[w.sourcePort].push(w.target.id);
                    }
                }
            }

            if (n.inputs > 0 && n.inputLabels && !/^\s*$/.test(n.inputLabels.join("")))  {
                node.inputLabels = n.inputLabels.slice();
            }
            if (n.outputs > 0 && n.outputLabels && !/^\s*$/.test(n.outputLabels.join(""))) {
                node.outputLabels = n.outputLabels.slice();
            }
            if ((!n._def.defaults || !n._def.defaults.hasOwnProperty("icon")) && n.icon) {
                var defIcon = RED.utils.getDefaultNodeIcon(n._def, n);
                if (n.icon !== defIcon.module+"/"+defIcon.file) {
                    node.icon = n.icon;
                }
            }
            if ((!n._def.defaults || !n._def.defaults.hasOwnProperty("l")) && n.hasOwnProperty('l')) {
                var isLink = /^link (in|out)$/.test(node.type);
                if (isLink == n.l) {
                    node.l = n.l;
                }
            }
        }
        if (n.info) {
            node.info = n.info;
        }
        return node;
    }

    function convertSubflow(n, opts) {
        var exportCreds = true;
        var exportDimensions = false;
        if (opts === false) {
            exportCreds = false;
        } else if (typeof opts === "object") {
            if (opts.hasOwnProperty("credentials")) {
                exportCreds = opts.credentials;
            }
            if (opts.hasOwnProperty("dimensions")) {
                exportDimensions = opts.dimensions;
            }
        }


        var node = {};
        node.id = n.id;
        node.type = n.type;
        node.name = n.name;
        node.info = n.info;
        node.category = n.category;
        node.in = [];
        node.out = [];
        node.env = n.env;
        node.meta = n.meta;

        if (exportCreds) {
            var credentialSet = {};
            // A subflow node can have arbitrary creds
            for (var sfCred in n.credentials) {
                if (n.credentials.hasOwnProperty(sfCred)) {
                    if (!n.credentials._ ||
                        n.credentials["has_"+sfCred] != n.credentials._["has_"+sfCred] ||
                        (n.credentials["has_"+sfCred] && n.credentials[sfCred])) {
                        credentialSet[sfCred] = n.credentials[sfCred];
                    }
                }
            }
            if (Object.keys(credentialSet).length > 0) {
                node.credentials = credentialSet;
            }
        }

        node.color = n.color;

        n.in.forEach(function(p) {
            var nIn = {x:p.x,y:p.y,wires:[]};
            var wires = links.filter(function(d) { return d.source === p });
            for (var i=0;i<wires.length;i++) {
                var w = wires[i];
                if (w.target.type != "subflow") {
                    nIn.wires.push({id:w.target.id})
                }
            }
            node.in.push(nIn);
        });
        n.out.forEach(function(p,c) {
            var nOut = {x:p.x,y:p.y,wires:[]};
            var wires = links.filter(function(d) { return d.target === p });
            for (i=0;i<wires.length;i++) {
                if (wires[i].source.type != "subflow") {
                    nOut.wires.push({id:wires[i].source.id,port:wires[i].sourcePort})
                } else {
                    nOut.wires.push({id:n.id,port:0})
                }
            }
            node.out.push(nOut);
        });

        if (node.in.length > 0 && n.inputLabels && !/^\s*$/.test(n.inputLabels.join("")))  {
            node.inputLabels = n.inputLabels.slice();
        }
        if (node.out.length > 0 && n.outputLabels && !/^\s*$/.test(n.outputLabels.join(""))) {
            node.outputLabels = n.outputLabels.slice();
        }
        if (n.icon) {
            if (n.icon !== "node-red/subflow.svg") {
                node.icon = n.icon;
            }
        }
        if (n.status) {
            node.status = {x: n.status.x, y: n.status.y, wires:[]};
            links.forEach(function(d) {
                if (d.target === n.status) {
                    if (d.source.type != "subflow") {
                        node.status.wires.push({id:d.source.id, port:d.sourcePort})
                    } else {
                        node.status.wires.push({id:n.id, port:0})
                    }
                }
            });
        }

        return node;
    }

    function createExportableSubflow(id) {
        var sf = getSubflow(id);
        var nodeSet = [sf];
        var sfNodeIds = Object.keys(nodeTabMap[sf.id]||{});
        for (var i=0, l=sfNodeIds.length; i<l; i++) {
            nodeSet.push(nodeTabMap[sf.id][sfNodeIds[i]]);
        }
        return createExportableNodeSet(nodeSet);
    }
    /**
     * Converts the current node selection to an exportable JSON Object
     **/
    function createExportableNodeSet(set, exportedIds, exportedSubflows, exportedConfigNodes) {
        var nns = [];

        exportedIds = exportedIds || {};
        set = set.filter(function(n) {
            if (exportedIds[n.id]) {
                return false;
            }
            exportedIds[n.id] = true;
            return true;
        })

        exportedConfigNodes = exportedConfigNodes || {};
        exportedSubflows = exportedSubflows || {};
        for (var n=0;n<set.length;n++) {
            var node = set[n];
            if (node.type.substring(0,8) == "subflow:") {
                var subflowId = node.type.substring(8);
                if (!exportedSubflows[subflowId]) {
                    exportedSubflows[subflowId] = true;
                    var subflow = getSubflow(subflowId);
                    var subflowSet = [subflow];
                    RED.nodes.eachNode(function(n) {
                        if (n.z == subflowId) {
                            subflowSet.push(n);
                        }
                    });
                    RED.nodes.eachConfig(function(n) {
                        if (n.z == subflowId) {
                            subflowSet.push(n);
                            exportedConfigNodes[n.id] = true;
                        }
                    });
                    var exportableSubflow = createExportableNodeSet(subflowSet, exportedIds, exportedSubflows, exportedConfigNodes);
                    nns = exportableSubflow.concat(nns);
                }
            }
            if (node.type !== "subflow") {
                var convertedNode = RED.nodes.convertNode(node);
                for (var d in node._def.defaults) {
                    if (node._def.defaults[d].type) {
                        var nodeList = node[d];
                        if (!Array.isArray(nodeList)) {
                            nodeList = [nodeList];
                        }
                        nodeList = nodeList.filter(function(id) {
                            if (id in configNodes) {
                                var confNode = configNodes[id];
                                if (confNode._def.exportable !== false) {
                                    if (!(id in exportedConfigNodes)) {
                                        exportedConfigNodes[id] = true;
                                        set.push(confNode);
                                    }
                                    return true;
                                }
                                return false;
                            }
                            return true;
                        })
                        if (nodeList.length === 0) {
                            convertedNode[d] = Array.isArray(node[d])?[]:""
                        } else {
                            convertedNode[d] = Array.isArray(node[d])?nodeList:nodeList[0]
                        }
                    }
                }
                nns.push(convertedNode);
                if (node.type === "group") {
                    nns = nns.concat(createExportableNodeSet(node.nodes, exportedIds, exportedSubflows, exportedConfigNodes));
                }
            } else {
                var convertedSubflow = convertSubflow(node);
                nns.push(convertedSubflow);
            }
        }
        return nns;
    }

    // Create the Flow JSON for the current configuration
    // opts.credentials (whether to include (known) credentials) - default: true
    // opts.dimensions (whether to include node dimensions) - default: false
    function createCompleteNodeSet(opts) {
        var nns = [];
        var i;
        for (i=0;i<workspacesOrder.length;i++) {
            if (workspaces[workspacesOrder[i]].type == "tab") {
                nns.push(convertWorkspace(workspaces[workspacesOrder[i]]));
            }
        }
        for (i in subflows) {
            if (subflows.hasOwnProperty(i)) {
                nns.push(convertSubflow(subflows[i], opts));
            }
        }
        for (i in groups) {
            if (groups.hasOwnProperty(i)) {
                nns.push(convertNode(groups[i], opts));
            }
        }
        for (i in configNodes) {
            if (configNodes.hasOwnProperty(i)) {
                nns.push(convertNode(configNodes[i], opts));
            }
        }
        for (i in nodes) {
            if (nodes.hasOwnProperty(i)) {
                nns.push(convertNode(nodes[i], opts));
            }
        }
        return nns;
    }

    function checkForMatchingSubflow(subflow,subflowNodes) {
        subflowNodes = subflowNodes || [];
        var i;
        var match = null;
        RED.nodes.eachSubflow(function(sf) {
            if (sf.name != subflow.name ||
                sf.info != subflow.info ||
                sf.in.length != subflow.in.length ||
                sf.out.length != subflow.out.length) {
                    return;
            }
            var sfNodes = RED.nodes.filterNodes({z:sf.id});
            if (sfNodes.length != subflowNodes.length) {
                return;
            }

            var subflowNodeSet = [subflow].concat(subflowNodes);
            var sfNodeSet = [sf].concat(sfNodes);

            var exportableSubflowNodes = JSON.stringify(subflowNodeSet);
            var exportableSFNodes = JSON.stringify(createExportableNodeSet(sfNodeSet));
            var nodeMap = {};
            for (i=0;i<sfNodes.length;i++) {
                exportableSubflowNodes = exportableSubflowNodes.replace(new RegExp("\""+subflowNodes[i].id+"\"","g"),'"'+sfNodes[i].id+'"');
            }
            exportableSubflowNodes = exportableSubflowNodes.replace(new RegExp("\""+subflow.id+"\"","g"),'"'+sf.id+'"');

            if (exportableSubflowNodes !== exportableSFNodes) {
                return;
            }

            match = sf;
            return false;
        });
        return match;
    }
    function compareNodes(nodeA,nodeB,idMustMatch) {
        if (idMustMatch && nodeA.id != nodeB.id) {
            return false;
        }
        if (nodeA.type != nodeB.type) {
            return false;
        }
        var def = nodeA._def;
        for (var d in def.defaults) {
            if (def.defaults.hasOwnProperty(d)) {
                var vA = nodeA[d];
                var vB = nodeB[d];
                if (typeof vA !== typeof vB) {
                    return false;
                }
                if (vA === null || typeof vA === "string" || typeof vA === "number") {
                    if (vA !== vB) {
                        return false;
                    }
                } else {
                    if (JSON.stringify(vA) !== JSON.stringify(vB)) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    function identifyImportConflicts(importedNodes) {
        var imported = {
            tabs: {},
            subflows: {},
            groups: {},
            configs: {},
            nodes: {},
            all: [],
            conflicted: {},
            zMap: {},
        }

        importedNodes.forEach(function(n) {
            imported.all.push(n);
            if (n.type === "tab") {
                imported.tabs[n.id] = n;
            } else if (n.type === "subflow") {
                imported.subflows[n.id] = n;
            } else if (n.type === "group") {
                imported.groups[n.id] = n;
            } else if (n.hasOwnProperty("x") && n.hasOwnProperty("y")) {
                imported.nodes[n.id] = n;
            } else {
                imported.configs[n.id] = n;
            }
            var nodeZ = n.z || "__global__";
            imported.zMap[nodeZ] = imported.zMap[nodeZ] || [];
            imported.zMap[nodeZ].push(n)
            if (nodes[n.id] || configNodes[n.id] || workspaces[n.id] || subflows[n.id] || groups[n.id]) {
                imported.conflicted[n.id] = n;
            }
        })
        return imported;

    }


    /**
     * Replace the provided nodes.
     * This must contain complete Subflow defs or complete Flow Tabs.
     * It does not replace an individual node in the middle of a flow.
     */
    function replaceNodes(newNodes) {
        var zMap = {};
        var newSubflows = {};
        var newConfigNodes = {};
        var removedNodes = [];
        // Figure out what we're being asked to replace - subflows/configNodes
        // TODO: config nodes
        newNodes.forEach(function(n) {
            if (n.type === "subflow") {
                newSubflows[n.id] = n;
            } else if (!n.hasOwnProperty('x') && !n.hasOwnProperty('y')) {
                newConfigNodes[n.id] = n;
            }
            if (n.z) {
                zMap[n.z] = zMap[n.z] || [];
                zMap[n.z].push(n);
            }
        })

        // Filter out config nodes inside a subflow def that is being replaced
        var configNodeIds = Object.keys(newConfigNodes);
        configNodeIds.forEach(function(id) {
            var n = newConfigNodes[id];
            if (newSubflows[n.z]) {
                // This config node is in a subflow to be replaced.
                //  - remove from the list as it'll get handled with the subflow
                delete newConfigNodes[id];
            }
        });
        // Rebuild the list of ids
        configNodeIds = Object.keys(newConfigNodes);

        // ------------------------------
        // Replace subflow definitions
        //
        // For each of the subflows to be replaced:
        var newSubflowIds = Object.keys(newSubflows);
        newSubflowIds.forEach(function(id) {
            var n = newSubflows[id];
            // Get a snapshot of the existing subflow definition
            removedNodes = removedNodes.concat(createExportableSubflow(id));
            // Remove the old subflow definition - but leave the instances in place
            var removalResult = RED.subflow.removeSubflow(n.id, true);
            // Create the list of nodes for the new subflow def
            var subflowNodes = [n].concat(zMap[n.id]);
            // Import the new subflow - no clashes should occur as we've removed
            // the old version
            var result = importNodes(subflowNodes);
            newSubflows[id] = getSubflow(id);
        })

        // Having replaced the subflow definitions, now need to update the
        // instance nodes.
        RED.nodes.eachNode(function(n) {
            if (/^subflow:/.test(n.type)) {
                var sfId = n.type.substring(8);
                if (newSubflows[sfId]) {
                    // This is an instance of one of the replaced subflows
                    //  - update the new def's instances array to include this one
                    newSubflows[sfId].instances.push(n);
                    //  - update the instance's _def to point to the new def
                    n._def = RED.nodes.getType(n.type);
                    //  - set all the flags so the view refreshes properly
                    n.dirty = true;
                    n.changed = true;
                    n._colorChanged = true;
                }
            }
        })

        newSubflowIds.forEach(function(id) {
            var n = newSubflows[id];
            RED.events.emit("subflows:change",n);
        })
        // Just in case the imported subflow changed color.
        RED.utils.clearNodeColorCache();

        // ------------------------------
        // Replace config nodes
        //
        configNodeIds.forEach(function(id) {
            removedNodes = removedNodes.concat(convertNode(getNode(id)));
            removeNode(id);
            importNodes([newConfigNodes[id]])
        });

        return {
            removedNodes: removedNodes
        }

    }

    /**
     * Options:
     *  - generateIds - whether to replace all node ids
     *  - addFlow - whether to import nodes to a new tab
     *  - importToCurrent
     *  - importMap - how to resolve any conflicts.
     *       - id:import - import as-is
     *       - id:copy - import with new id
     *       - id:replace - import over the top of existing
     */
    function importNodes(newNodesObj,options) { // createNewIds,createMissingWorkspace) {
        options = options || {
            generateIds: false,
            addFlow: false,
        }
        options.importMap = options.importMap || {};

        var createNewIds = options.generateIds;
        var createMissingWorkspace = options.addFlow;
        var i;
        var n;
        var newNodes;
        var nodeZmap = {};
        var recoveryWorkspace;
        if (typeof newNodesObj === "string") {
            if (newNodesObj === "") {
                return;
            }
            try {
                newNodes = JSON.parse(newNodesObj);
            } catch(err) {
                var e = new Error(RED._("clipboard.invalidFlow",{message:err.message}));
                e.code = "NODE_RED";
                throw e;
            }
        } else {
            newNodes = newNodesObj;
        }

        if (!$.isArray(newNodes)) {
            newNodes = [newNodes];
        }

        // Scan for any duplicate nodes and remove them. This is a temporary
        // fix to help resolve corrupted flows caused by 0.20.0 where multiple
        // copies of the flow would get loaded at the same time.
        // If the user hit deploy they would have saved those duplicates.
        var seenIds = {};
        var existingNodes = [];
        var nodesToReplace = [];

        newNodes = newNodes.filter(function(n) {
            var id = n.id;
            if (seenIds[n.id]) {
                return false;
            }
            seenIds[n.id] = true;

            if (!options.generateIds) {
                if (!options.importMap[id]) {
                    // No conflict resolution for this node
                    var existing = nodes[id] || configNodes[id] || workspaces[id] || subflows[id] || groups[id];
                    if (existing) {
                        existingNodes.push({existing:existing, imported:n});
                    }
                } else if (options.importMap[id] === "replace") {
                    nodesToReplace.push(n);
                    return false;
                }
            }

            return true;
        })

        if (existingNodes.length > 0) {
            var errorMessage = RED._("clipboard.importDuplicate",{count:existingNodes.length});
            var nodeList = $("<ul>");
            var existingNodesCount = Math.min(5,existingNodes.length);
            for (var i=0;i<existingNodesCount;i++) {
                var conflict = existingNodes[i];
                $("<li>").text(
                    conflict.existing.id+
                    " [ "+conflict.existing.type+ ((conflict.imported.type !== conflict.existing.type)?" | "+conflict.imported.type:"")+" ]").appendTo(nodeList)
            }
            if (existingNodesCount !== existingNodes.length) {
                $("<li>").text(RED._("deploy.confirm.plusNMore",{count:existingNodes.length-existingNodesCount})).appendTo(nodeList)
            }
            var wrapper = $("<p>").append(nodeList);

            var existingNodesError = new Error(errorMessage+wrapper.html());
            existingNodesError.code = "import_conflict";
            existingNodesError.importConfig = identifyImportConflicts(newNodes);
            throw existingNodesError;
        }
        var removedNodes;
        if (nodesToReplace.length > 0) {
            var replaceResult = replaceNodes(nodesToReplace);
            removedNodes = replaceResult.removedNodes;
        }


        var isInitialLoad = false;
        if (!initialLoad) {
            isInitialLoad = true;
            initialLoad = JSON.parse(JSON.stringify(newNodes));
        }
        var unknownTypes = [];
        for (i=0;i<newNodes.length;i++) {
            n = newNodes[i];
            var id = n.id;
            // TODO: remove workspace in next release+1
            if (n.type != "workspace" &&
                n.type != "tab" &&
                n.type != "subflow" &&
                n.type != "group" &&
                !registry.getNodeType(n.type) &&
                n.type.substring(0,8) != "subflow:" &&
                unknownTypes.indexOf(n.type)==-1) {
                    unknownTypes.push(n.type);
            }
            if (n.z) {
                nodeZmap[n.z] = nodeZmap[n.z] || [];
                nodeZmap[n.z].push(n);
            } else if (isInitialLoad && n.hasOwnProperty('x') && n.hasOwnProperty('y') && !n.z) {
                // Hit the rare issue where node z values get set to 0.
                // Repair the flow - but we really need to track that down.
                if (!recoveryWorkspace) {
                    recoveryWorkspace = {
                        id: RED.nodes.id(),
                        type: "tab",
                        disabled: false,
                        label: RED._("clipboard.recoveredNodes"),
                        info: RED._("clipboard.recoveredNodesInfo")
                    }
                    addWorkspace(recoveryWorkspace);
                    RED.workspaces.add(recoveryWorkspace);
                    nodeZmap[recoveryWorkspace.id] = [];
                }
                n.z = recoveryWorkspace.id;
                nodeZmap[recoveryWorkspace.id].push(n);
            }

        }
        if (!isInitialLoad && unknownTypes.length > 0) {
            var typeList = $("<ul>");
            unknownTypes.forEach(function(t) {
                $("<li>").text(t).appendTo(typeList);
            })
            typeList = typeList[0].outerHTML;
            RED.notify("<p>"+RED._("clipboard.importUnrecognised",{count:unknownTypes.length})+"</p>"+typeList,"error",false,10000);
        }

        var activeWorkspace = RED.workspaces.active();
        //TODO: check the z of the subflow instance and check _that_ if it exists
        var activeSubflow = getSubflow(activeWorkspace);
        for (i=0;i<newNodes.length;i++) {
            var m = /^subflow:(.+)$/.exec(newNodes[i].type);
            if (m) {
                var subflowId = m[1];
                var parent = getSubflow(activeWorkspace);
                if (parent) {
                    var err;
                    if (subflowId === parent.id) {
                        err = new Error(RED._("notification.errors.cannotAddSubflowToItself"));
                    }
                    if (subflowContains(subflowId,parent.id)) {
                        err = new Error(RED._("notification.errors.cannotAddCircularReference"));
                    }
                    if (err) {
                        // TODO: standardise error codes
                        err.code = "NODE_RED";
                        throw err;
                    }
                }
            }
        }

        var new_workspaces = [];
        var workspace_map = {};
        var new_subflows = [];
        var subflow_map = {};
        var subflow_denylist = {};
        var node_map = {};
        var new_nodes = [];
        var new_links = [];
        var new_groups = [];
        var new_group_set = new Set();
        var nid;
        var def;
        var configNode;
        var missingWorkspace = null;
        var d;

        if (recoveryWorkspace) {
            new_workspaces.push(recoveryWorkspace);
        }

        // Find all tabs and subflow templates
        for (i=0;i<newNodes.length;i++) {
            n = newNodes[i];
            // TODO: remove workspace in next release+1
            if (n.type === "workspace" || n.type === "tab") {
                if (n.type === "workspace") {
                    n.type = "tab";
                }
                if (defaultWorkspace == null) {
                    defaultWorkspace = n;
                }
                if (activeWorkspace === 0) {
                    activeWorkspace = n.id;
                }
                if (createNewIds || options.importMap[n.id] === "copy") {
                    nid = getID();
                    workspace_map[n.id] = nid;
                    n.id = nid;
                } else {
                    workspace_map[n.id] = n.id;
                }
                addWorkspace(n);
                RED.workspaces.add(n);
                new_workspaces.push(n);
            } else if (n.type === "subflow") {
                var matchingSubflow;
                if (!options.importMap[n.id]) {
                    matchingSubflow = checkForMatchingSubflow(n,nodeZmap[n.id]);
                }
                if (matchingSubflow) {
                    subflow_denylist[n.id] = matchingSubflow;
                } else {
                    subflow_map[n.id] = n;
                    if (createNewIds || options.importMap[n.id] === "copy") {
                        nid = getID();
                        n.id = nid;
                    }
                    // TODO: handle createNewIds - map old to new subflow ids
                    n.in.forEach(function(input,i) {
                        input.type = "subflow";
                        input.direction = "in";
                        input.z = n.id;
                        input.i = i;
                        input.id = getID();
                    });
                    n.out.forEach(function(output,i) {
                        output.type = "subflow";
                        output.direction = "out";
                        output.z = n.id;
                        output.i = i;
                        output.id = getID();
                    });
                    if (n.status) {
                        n.status.type = "subflow";
                        n.status.direction = "status";
                        n.status.z = n.id;
                        n.status.id = getID();
                    }
                    new_subflows.push(n);
                    addSubflow(n,createNewIds || options.importMap[n.id] === "copy");
                }
            }
        }

        // Add a tab if there isn't one there already
        if (defaultWorkspace == null) {
            defaultWorkspace = { type:"tab", id:getID(), disabled: false, info:"",  label:RED._('workspace.defaultName',{number:1})};
            addWorkspace(defaultWorkspace);
            RED.workspaces.add(defaultWorkspace);
            new_workspaces.push(defaultWorkspace);
            activeWorkspace = RED.workspaces.active();
        }

        // Find all config nodes and add them
        for (i=0;i<newNodes.length;i++) {
            n = newNodes[i];
            def = registry.getNodeType(n.type);
            if (def && def.category == "config") {
                var existingConfigNode = null;
                if (createNewIds || options.importMap[n.id] === "copy") {
                    if (n.z) {
                        if (subflow_denylist[n.z]) {
                            continue;
                        } else if (subflow_map[n.z]) {
                            n.z = subflow_map[n.z].id;
                        } else {
                            n.z = workspace_map[n.z];
                            if (!workspaces[n.z]) {
                                if (createMissingWorkspace) {
                                    if (missingWorkspace === null) {
                                        missingWorkspace = RED.workspaces.add(null,true);
                                        new_workspaces.push(missingWorkspace);
                                    }
                                    n.z = missingWorkspace.id;
                                } else {
                                    n.z = activeWorkspace;
                                }
                            }
                        }
                    }
                    if (options.importMap[n.id] !== "copy") {
                        existingConfigNode = RED.nodes.node(n.id);
                        if (existingConfigNode) {
                            if (n.z && existingConfigNode.z !== n.z) {
                                existingConfigNode = null;
                                // Check the config nodes on n.z
                                for (var cn in configNodes) {
                                    if (configNodes.hasOwnProperty(cn)) {
                                        if (configNodes[cn].z === n.z && compareNodes(configNodes[cn],n,false)) {
                                            existingConfigNode = configNodes[cn];
                                            node_map[n.id] = configNodes[cn];
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    if (n.z && !workspace_map[n.z] && !subflow_map[n.z]) {
                        n.z = activeWorkspace;
                    }
                }

                if (!existingConfigNode || existingConfigNode._def.exclusive) { //} || !compareNodes(existingConfigNode,n,true) || existingConfigNode.z !== n.z) {
                    configNode = {
                        id:n.id,
                        z:n.z,
                        type:n.type,
                        info: n.info,
                        users:[],
                        _config:{}
                    };
                    if (!n.z) {
                        delete configNode.z;
                    }
                    if (n.hasOwnProperty('d')) {
                        configNode.d = n.d;
                    }
                    for (d in def.defaults) {
                        if (def.defaults.hasOwnProperty(d)) {
                            configNode[d] = n[d];
                            configNode._config[d] = JSON.stringify(n[d]);
                        }
                    }
                    if (def.hasOwnProperty('credentials') && n.hasOwnProperty('credentials')) {
                        configNode.credentials = {};
                        for (d in def.credentials) {
                            if (def.credentials.hasOwnProperty(d) && n.credentials.hasOwnProperty(d)) {
                                configNode.credentials[d] = n.credentials[d];
                            }
                        }
                    }
                    configNode.label = def.label;
                    configNode._def = def;
                    if (createNewIds || options.importMap[n.id] === "copy") {
                        configNode.id = getID();
                    }
                    node_map[n.id] = configNode;
                    new_nodes.push(configNode);
                }
            }
        }

        // Find regular flow nodes and subflow instances
        for (i=0;i<newNodes.length;i++) {
            n = newNodes[i];
            // TODO: remove workspace in next release+1
            if (n.type !== "workspace" && n.type !== "tab" && n.type !== "subflow") {
                def = registry.getNodeType(n.type);
                if (!def || def.category != "config") {
                    var node = {
                        x:parseFloat(n.x || 0),
                        y:parseFloat(n.y || 0),
                        z:n.z,
                        type:0,
                        info: n.info,
                        changed:false,
                        _config:{}
                    }
                    if (n.type !== "group") {
                        node.wires = n.wires||[];
                        node.inputLabels = n.inputLabels;
                        node.outputLabels = n.outputLabels;
                        node.icon = n.icon;
                    }
                    if (n.hasOwnProperty('l')) {
                        node.l = n.l;
                    }
                    if (n.hasOwnProperty('d')) {
                        node.d = n.d;
                    }
                    if (n.hasOwnProperty('g')) {
                        node.g = n.g;
                    }
                    if (createNewIds || options.importMap[n.id] === "copy") {
                        if (subflow_denylist[n.z]) {
                            continue;
                        } else if (subflow_map[node.z]) {
                            node.z = subflow_map[node.z].id;
                        } else {
                            node.z = workspace_map[node.z];
                            if (!workspaces[node.z]) {
                                if (createMissingWorkspace) {
                                    if (missingWorkspace === null) {
                                        missingWorkspace = RED.workspaces.add(null,true);
                                        new_workspaces.push(missingWorkspace);
                                    }
                                    node.z = missingWorkspace.id;
                                } else {
                                    node.z = activeWorkspace;
                                }
                            }
                        }
                        node.id = getID();
                    } else {
                        node.id = n.id;
                        if (node.z == null || (!workspace_map[node.z] && !subflow_map[node.z])) {
                            if (createMissingWorkspace) {
                                if (missingWorkspace === null) {
                                    missingWorkspace = RED.workspaces.add(null,true);
                                    new_workspaces.push(missingWorkspace);
                                }
                                node.z = missingWorkspace.id;
                            } else {
                                node.z = activeWorkspace;
                            }
                        }
                    }
                    node.type = n.type;
                    node._def = def;
                    if (node.type === "group") {
                        node._def = RED.group.def;
                        for (d in node._def.defaults) {
                            if (node._def.defaults.hasOwnProperty(d) && d !== 'inputs' && d !== 'outputs') {
                                node[d] = n[d];
                                node._config[d] = JSON.stringify(n[d]);
                            }
                        }
                        node._config.x = node.x;
                        node._config.y = node.y;
                    } else if (n.type.substring(0,7) === "subflow") {
                        var parentId = n.type.split(":")[1];
                        var subflow = subflow_denylist[parentId]||subflow_map[parentId]||getSubflow(parentId);
                        if (createNewIds || options.importMap[n.id] === "copy") {
                            parentId = subflow.id;
                            node.type = "subflow:"+parentId;
                            node._def = registry.getNodeType(node.type);
                            delete node.i;
                        }
                        node.name = n.name;
                        node.outputs = subflow.out.length;
                        node.inputs = subflow.in.length;
                        node.env = n.env;
                    } else {
                        if (!node._def) {
                            if (node.x && node.y) {
                                node._def = {
                                    color:"#fee",
                                    defaults: {},
                                    label: "unknown: "+n.type,
                                    labelStyle: "red-ui-flow-node-label-italic",
                                    outputs: n.outputs|| (n.wires && n.wires.length) || 0,
                                    set: registry.getNodeSet("node-red/unknown")
                                }
                            } else {
                                node._def = {
                                    category:"config",
                                    set: registry.getNodeSet("node-red/unknown")
                                };
                                node.users = [];
                                // This is a config node, so delete the default
                                // non-config node properties
                                delete node.x;
                                delete node.y;
                                delete node.wires;
                                delete node.inputLabels;
                                delete node.outputLabels;
                                if (!n.z) {
                                    delete node.z;
                                }
                            }
                            var orig = {};
                            for (var p in n) {
                                if (n.hasOwnProperty(p) && p!="x" && p!="y" && p!="z" && p!="id" && p!="wires") {
                                    orig[p] = n[p];
                                }
                            }
                            node._orig = orig;
                            node.name = n.type;
                            node.type = "unknown";
                        }
                        if (node._def.category != "config") {
                            if (n.hasOwnProperty('inputs')) {
                                node.inputs = n.inputs;
                                node._config.inputs = JSON.stringify(n.inputs);
                            } else {
                                node.inputs = node._def.inputs;
                            }
                            if (n.hasOwnProperty('outputs')) {
                                node.outputs = n.outputs;
                                node._config.outputs = JSON.stringify(n.outputs);
                            } else {
                                node.outputs = node._def.outputs;
                            }
                            if (node.hasOwnProperty('wires') && node.wires.length > node.outputs) {
                                if (!node._def.defaults.hasOwnProperty("outputs") || !isNaN(parseInt(n.outputs))) {
                                    // If 'wires' is longer than outputs, clip wires
                                    console.log("Warning: node.wires longer than node.outputs - trimming wires:",node.id," wires:",node.wires.length," outputs:",node.outputs);
                                    node.wires = node.wires.slice(0,node.outputs);
                                } else {
                                    // The node declares outputs in its defaults, but has not got a valid value
                                    // Defer to the length of the wires array
                                    node.outputs = node.wires.length;
                                }
                            }
                            for (d in node._def.defaults) {
                                if (node._def.defaults.hasOwnProperty(d) && d !== 'inputs' && d !== 'outputs') {
                                    node[d] = n[d];
                                    node._config[d] = JSON.stringify(n[d]);
                                }
                            }
                            node._config.x = node.x;
                            node._config.y = node.y;
                            if (node._def.hasOwnProperty('credentials') && n.hasOwnProperty('credentials')) {
                                node.credentials = {};
                                for (d in node._def.credentials) {
                                    if (node._def.credentials.hasOwnProperty(d) && n.credentials.hasOwnProperty(d)) {
                                        node.credentials[d] = n.credentials[d];
                                    }
                                }
                            }
                        }
                    }
                    node_map[n.id] = node;
                    // If an 'unknown' config node, it will not have been caught by the
                    // proper config node handling, so needs adding to new_nodes here
                    if (node.type === "unknown" || node._def.category !== "config") {
                        new_nodes.push(node);
                    } else if (node.type === "group") {
                        new_groups.push(node);
                        new_group_set.add(node.id);
                    }
                }
            }
        }

        // Remap all wires and config node references
        for (i=0;i<new_nodes.length;i++) {
            n = new_nodes[i];
            if (n.wires) {
                for (var w1=0;w1<n.wires.length;w1++) {
                    var wires = (n.wires[w1] instanceof Array)?n.wires[w1]:[n.wires[w1]];
                    for (var w2=0;w2<wires.length;w2++) {
                        if (node_map.hasOwnProperty(wires[w2])) {
                            if (n.z === node_map[wires[w2]].z) {
                                var link = {source:n,sourcePort:w1,target:node_map[wires[w2]]};
                                addLink(link);
                                new_links.push(link);
                            } else {
                                console.log("Warning: dropping link that crosses tabs:",n.id,"->",node_map[wires[w2]].id);
                            }
                        }
                    }
                }
                delete n.wires;
            }
            if (n.g && node_map[n.g]) {
                n.g = node_map[n.g].id;
            } else {
                delete n.g
            }
            for (var d3 in n._def.defaults) {
                if (n._def.defaults.hasOwnProperty(d3)) {
                    if (n._def.defaults[d3].type) {
                        var nodeList = n[d3];
                        if (!Array.isArray(nodeList)) {
                            nodeList = [nodeList];
                        }
                        nodeList = nodeList.map(function(id) {
                            var node = node_map[id];
                            if (node) {
                                if (node._def.category === 'config') {
                                    if (node.users.indexOf(n) === -1) {
                                        node.users.push(n);
                                    }
                                }
                                return node.id;
                            }
                            return id;
                        })
                        n[d3] = Array.isArray(n[d3])?nodeList:nodeList[0];
                    }
                }
            }
            // If importing into a subflow, ensure an outbound-link doesn't
            // get added
            if (activeSubflow && /^link /.test(n.type) && n.links) {
                n.links = n.links.filter(function(id) {
                    var otherNode = RED.nodes.node(id);
                    return (otherNode && otherNode.z === activeWorkspace)
                });
            }
        }
        for (i=0;i<new_subflows.length;i++) {
            n = new_subflows[i];
            n.in.forEach(function(input) {
                input.wires.forEach(function(wire) {
                    var link = {source:input, sourcePort:0, target:node_map[wire.id]};
                    addLink(link);
                    new_links.push(link);
                });
                delete input.wires;
            });
            n.out.forEach(function(output) {
                output.wires.forEach(function(wire) {
                    var link;
                    if (subflow_map[wire.id] && subflow_map[wire.id].id == n.id) {
                        link = {source:n.in[wire.port], sourcePort:wire.port,target:output};
                    } else {
                        link = {source:node_map[wire.id]||subflow_map[wire.id], sourcePort:wire.port,target:output};
                    }
                    addLink(link);
                    new_links.push(link);
                });
                delete output.wires;
            });
            if (n.status) {
                n.status.wires.forEach(function(wire) {
                    var link;
                    if (subflow_map[wire.id] && subflow_map[wire.id].id == n.id) {
                        link = {source:n.in[wire.port], sourcePort:wire.port,target:n.status};
                    } else {
                        link = {source:node_map[wire.id]||subflow_map[wire.id], sourcePort:wire.port,target:n.status};
                    }
                    addLink(link);
                    new_links.push(link);
                });
                delete n.status.wires;
            }
        }
        // Order the groups to ensure they are outer-most to inner-most
        var groupDepthMap = {};
        for (i=0;i<new_groups.length;i++) {
            n = new_groups[i];

            if (n.g && !new_group_set.has(n.g)) {
                delete n.g;
            }
            n.nodes = n.nodes.map(function(id) {
                return node_map[id];
            })
            // Just in case the group references a node that doesn't exist for some reason
            n.nodes = n.nodes.filter(function(v) {
                if (v) {
                    // Repair any nodes that have forgotten they are in this group
                    if (v.g !== n.id) {
                        v.g = n.id;
                    }
                }
                return !!v
            });
            if (!n.g) {
                groupDepthMap[n.id] = 0;
            }
        }
        var changedDepth;
        do {
            changedDepth = false;
            for (i=0;i<new_groups.length;i++) {
                n = new_groups[i];
                if (n.g) {
                    if (groupDepthMap[n.id] !== groupDepthMap[n.g] + 1) {
                        groupDepthMap[n.id] = groupDepthMap[n.g] + 1;
                        changedDepth = true;
                    }
                }
            }
        } while(changedDepth);

        new_groups.sort(function(A,B) {
            return groupDepthMap[A.id] - groupDepthMap[B.id];
        });
        for (i=0;i<new_groups.length;i++) {
            n = new_groups[i];
            addGroup(n);
        }

        // Now the nodes have been fully updated, add them.
        for (i=0;i<new_nodes.length;i++) {
            var node = new_nodes[i];
            addNode(node);
        }
        // Finally validate them all.
        // This has to be done after everything is added so that any checks for
        // dependent config nodes will pass
        for (i=0;i<new_nodes.length;i++) {
            var node = new_nodes[i];
            RED.editor.validateNode(node);
        }

        RED.workspaces.refresh();


        if (recoveryWorkspace) {
            var notification = RED.notify(RED._("clipboard.recoveredNodesNotification",{flowName:RED._("clipboard.recoveredNodes")}),{
                type:"warning",
                fixed:true,
                buttons: [
                    {text: RED._("common.label.close"), click: function() { notification.close() }}
                ]
            });
        }

        return {
            nodes:new_nodes,
            links:new_links,
            groups:new_groups,
            workspaces:new_workspaces,
            subflows:new_subflows,
            missingWorkspace: missingWorkspace,
            removedNodes: removedNodes
        }
    }

    // TODO: supports filter.z|type
    function filterNodes(filter) {
        var result = [];
        var searchSet = null;
        var doZFilter = false;
        if (filter.hasOwnProperty("z")) {
            if (nodeTabMap.hasOwnProperty(filter.z)) {
                searchSet = Object.keys(nodeTabMap[filter.z]);
            } else {
                doZFilter = true;
            }
        }
        if (searchSet === null) {
            searchSet = Object.keys(nodes);
        }

        for (var n=0;n<searchSet.length;n++) {
            var node = nodes[searchSet[n]];
            if (filter.hasOwnProperty("type") && node.type !== filter.type) {
                continue;
            }
            if (doZFilter && node.z !== filter.z) {
                continue;
            }
            result.push(node);
        }
        return result;
    }
    function filterLinks(filter) {
        var result = [];
        var candidateLinks = [];
        var hasCandidates = false;
        var filterSZ = filter.source && filter.source.z;
        var filterTZ = filter.target && filter.target.z;
        var filterZ;
        if (filterSZ || filterTZ) {
            if (filterSZ === filterTZ) {
                filterZ = filterSZ;
            } else {
                filterZ = (filterSZ === undefined)?filterTZ:filterSZ
            }
        }
        if (filterZ) {
            candidateLinks = linkTabMap[filterZ] || [];
            hasCandidates = true;
        } else if (filter.source && filter.source.hasOwnProperty("id")) {
            if (nodeLinks[filter.source.id]) {
                hasCandidates = true;
                candidateLinks = candidateLinks.concat(nodeLinks[filter.source.id].out)
            }
        } else if (filter.target && filter.target.hasOwnProperty("id")) {
            if (nodeLinks[filter.target.id]) {
                hasCandidates = true;
                candidateLinks = candidateLinks.concat(nodeLinks[filter.target.id].in)
            }
        }
        if (!hasCandidates) {
            candidateLinks = links;
        }
        for (var n=0;n<candidateLinks.length;n++) {
            var link = candidateLinks[n];
            if (filter.source) {
                if (filter.source.hasOwnProperty("id") && link.source.id !== filter.source.id) {
                    continue;
                }
                if (filter.source.hasOwnProperty("z") && link.source.z !== filter.source.z) {
                    continue;
                }
            }
            if (filter.target) {
                if (filter.target.hasOwnProperty("id") && link.target.id !== filter.target.id) {
                    continue;
                }
                if (filter.target.hasOwnProperty("z") && link.target.z !== filter.target.z) {
                    continue;
                }
            }
            if (filter.hasOwnProperty("sourcePort") && link.sourcePort !== filter.sourcePort) {
                continue;
            }
            result.push(link);
        }
        return result;
    }

    // Update any config nodes referenced by the provided node to ensure their 'users' list is correct
    function updateConfigNodeUsers(n) {
        for (var d in n._def.defaults) {
            if (n._def.defaults.hasOwnProperty(d)) {
                var property = n._def.defaults[d];
                if (property.type) {
                    var type = registry.getNodeType(property.type);
                    if (type && type.category == "config") {
                        var configNode = configNodes[n[d]];
                        if (configNode) {
                            if (configNode.users.indexOf(n) === -1) {
                                configNode.users.push(n);
                                RED.events.emit('nodes:change',configNode)
                            }
                        }
                    }
                }
            }
        }
    }

    function flowVersion(version) {
        if (version !== undefined) {
            loadedFlowVersion = version;
        } else {
            return loadedFlowVersion;
        }
    }

    function clear() {
        nodes = {};
        links = [];
        nodeTabMap = {};
        linkTabMap = {};
        nodeLinks = {};
        configNodes = {};
        workspacesOrder = [];
        groups = {};
        groupsByZ = {};

        var subflowIds = Object.keys(subflows);
        subflowIds.forEach(function(id) {
            RED.subflow.removeSubflow(id)
        });
        var workspaceIds = Object.keys(workspaces);
        workspaceIds.forEach(function(id) {
            RED.workspaces.remove(workspaces[id]);
        });
        defaultWorkspace = null;
        initialLoad = null;
        workspaces = {};

        RED.nodes.dirty(false);
        RED.view.redraw(true, true);
        RED.palette.refresh();
        RED.workspaces.refresh();
        RED.sidebar.config.refresh();
        RED.sidebar.info.refresh();

        RED.events.emit("workspace:clear");
    }

    function addGroup(group) {
        groupsByZ[group.z] = groupsByZ[group.z] || [];
        groupsByZ[group.z].push(group);
        groups[group.id] = group;
        RED.events.emit("groups:add",group);
    }
    function removeGroup(group) {
        var i = groupsByZ[group.z].indexOf(group);
        groupsByZ[group.z].splice(i,1);
        if (groupsByZ[group.z].length === 0) {
            delete groupsByZ[group.z];
        }
        if (group.g) {
            if (groups[group.g]) {
                var index = groups[group.g].nodes.indexOf(group);
                groups[group.g].nodes.splice(index,1);
            }
        }
        RED.group.markDirty(group);

        delete groups[group.id];
        RED.events.emit("groups:remove",group);
    }

    function getNodeHelp(type) {
        var helpContent = "";
        var helpElement = $("script[data-help-name='"+type+"']");
        if (helpElement) {
            helpContent = helpElement.html();
            var helpType = helpElement.attr("type");
            if (helpType === "text/markdown") {
                helpContent = RED.utils.renderMarkdown(helpContent);
            }
        }
        return helpContent;
    }

    return {
        init: function() {
            RED.events.on("registry:node-type-added",function(type) {
                var def = registry.getNodeType(type);
                var replaced = false;
                var replaceNodes = {};
                RED.nodes.eachNode(function(n) {
                    if (n.type === "unknown" && n.name === type) {
                        replaceNodes[n.id] = n;
                    }
                });
                RED.nodes.eachConfig(function(n) {
                    if (n.type === "unknown" && n.name === type) {
                        replaceNodes[n.id] = n;
                    }
                });

                var replaceNodeIds = Object.keys(replaceNodes);
                if (replaceNodeIds.length > 0) {
                    var reimportList = [];
                    replaceNodeIds.forEach(function(id) {
                        var n = replaceNodes[id];
                        if (configNodes.hasOwnProperty(n.id)) {
                            delete configNodes[n.id];
                        } else {
                            delete nodes[n.id];
                            if (nodeTabMap[n.z]) {
                                delete nodeTabMap[n.z][n.id];
                            }
                        }
                        reimportList.push(convertNode(n));
                        RED.events.emit('nodes:remove',n);
                    });

                    // Remove any links between nodes that are going to be reimported.
                    // This prevents a duplicate link from being added.
                    var removeLinks = [];
                    RED.nodes.eachLink(function(l) {
                        if (replaceNodes.hasOwnProperty(l.source.id) && replaceNodes.hasOwnProperty(l.target.id)) {
                            removeLinks.push(l);
                        }
                    });
                    removeLinks.forEach(removeLink);

                    // Force the redraw to be synchronous so the view updates
                    // *now* and removes the unknown node
                    RED.view.redraw(true, true);
                    var result = importNodes(reimportList,{generateIds:false});
                    var newNodeMap = {};
                    result.nodes.forEach(function(n) {
                        newNodeMap[n.id] = n;
                    });
                    RED.nodes.eachLink(function(l) {
                        if (newNodeMap.hasOwnProperty(l.source.id)) {
                            l.source = newNodeMap[l.source.id];
                        }
                        if (newNodeMap.hasOwnProperty(l.target.id)) {
                            l.target = newNodeMap[l.target.id];
                        }
                    });
                    RED.view.redraw(true);
                }
            });
        },
        registry:registry,
        setNodeList: registry.setNodeList,

        getNodeSet: registry.getNodeSet,
        addNodeSet: registry.addNodeSet,
        removeNodeSet: registry.removeNodeSet,
        enableNodeSet: registry.enableNodeSet,
        disableNodeSet: registry.disableNodeSet,

        setIconSets: registry.setIconSets,
        getIconSets: registry.getIconSets,

        registerType: registry.registerNodeType,
        getType: registry.getNodeType,
        getNodeHelp: getNodeHelp,
        convertNode: convertNode,

        add: addNode,
        remove: removeNode,
        clear: clear,

        moveNodeToTab: moveNodeToTab,

        addLink: addLink,
        removeLink: removeLink,

        addWorkspace: addWorkspace,
        removeWorkspace: removeWorkspace,
        getWorkspaceOrder: function() { return workspacesOrder },
        setWorkspaceOrder: function(order) { workspacesOrder = order; },
        workspace: getWorkspace,

        addSubflow: addSubflow,
        removeSubflow: removeSubflow,
        subflow: getSubflow,
        subflowContains: subflowContains,

        addGroup: addGroup,
        removeGroup: removeGroup,
        group: function(id) { return groups[id] },
        groups: function(z) { return groupsByZ[z]||[] },

        eachNode: function(cb) {
            for (var id in nodes) {
                if (nodes.hasOwnProperty(id)) {
                    if (cb(nodes[id]) === false) {
                        break;
                    }
                }
            }
        },
        eachLink: function(cb) {
            for (var l=0;l<links.length;l++) {
                if (cb(links[l]) === false) {
                    break;
                }
            }
        },
        eachConfig: function(cb) {
            for (var id in configNodes) {
                if (configNodes.hasOwnProperty(id)) {
                    if (cb(configNodes[id]) === false) {
                        break;
                    }
                }
            }
        },
        eachSubflow: function(cb) {
            for (var id in subflows) {
                if (subflows.hasOwnProperty(id)) {
                    if (cb(subflows[id]) === false) {
                        break;
                    }
                }
            }
        },
        eachWorkspace: function(cb) {
            for (var i=0;i<workspacesOrder.length;i++) {
                if (cb(workspaces[workspacesOrder[i]]) === false) {
                    break;
                }
            }
        },

        node: getNode,

        version: flowVersion,
        originalFlow: function(flow) {
            if (flow === undefined) {
                return initialLoad;
            } else {
                initialLoad = flow;
            }
        },

        filterNodes: filterNodes,
        filterLinks: filterLinks,

        import: importNodes,

        identifyImportConflicts: identifyImportConflicts,

        getAllFlowNodes: getAllFlowNodes,
        getAllUpstreamNodes: getAllUpstreamNodes,
        getAllDownstreamNodes: getAllDownstreamNodes,
        createExportableNodeSet: createExportableNodeSet,
        createCompleteNodeSet: createCompleteNodeSet,
        updateConfigNodeUsers: updateConfigNodeUsers,
        id: getID,
        dirty: function(d) {
            if (d == null) {
                return dirty;
            } else {
                setDirty(d);
            }
        }
    };
})();
