treeherder.factory('thStringOverlap', function() {
    return function(str1, str2) {
        // Get a measure of the similarity of two strings by a simple process
        // of tokenizing and then computing the ratio of the tokens in common to
        // the total tokens

        var tokens = [str1, str2]
                .map(function (str) {
                    // Replace paths like /foo/bar/baz.html with just the filename baz.html
                    return str.replace(/[^\s]+\/([^\s]+)\s/,
                                       function(m, p1) {
                                           return " " + p1 + " ";
                                       });
                })
                .map(function (str) {
                    // Split into tokens on whitespace / ,  and |
                    return str.split(/[\s\/\,|]+/).filter(function(x) {return x !== "";});
                });

        if (tokens[0].length === 0 || tokens[1].length === 0) {
            return 0;
        }

        var tokenCounts = tokens.map(function(tokens) {
            return _.countBy(tokens, function(x) {return x;});
        });

        var overlap = Object.keys(tokenCounts[0])
                .reduce(function(overlap, x) {
                    if (tokenCounts[1].hasOwnProperty(x)) {
                        overlap += 2 * Math.min(tokenCounts[0][x], tokenCounts[1][x]);
                    }
                    return overlap;
                }, 0);

        return overlap / (tokens[0].length + tokens[1].length);

    };
});

treeherder.factory('ThErrorLineData', [
    function() {
        function ThErrorLineData(line) {
            this.id = line.id;
            this.data = line;
            this.verified = line.best_is_verified,
            this.verifiedIgnore = this.verified && (line.bug_number === 0 ||
                                                    line.best_classification === null);
            this.bugNumber = line.best_classification ? line.best_classification.bug_number : null;
            this.state = {
                classifiedFailureId: null,
                bugNumber: null
            };
        }
        return ThErrorLineData;
    }
]);

treeherder.factory('ThClassificationOption', ['thExtendProperties',
    function(thExtendProperties) {
        var ThClassificationOption = function(type, id, classifiedFailureId, bugNumber,
                                              bugSummary, bugResolution, matches) {
            thExtendProperties(this, {
                type: type,
                id: id,
                classifiedFailureId: classifiedFailureId || null,
                bugNumber: bugNumber || null,
                bugSummary: bugSummary || null,
                bugResolution: bugResolution || null,
                matches: matches || null,
                isBest: false,
                hidden: false,
                score: null
            });
        };
        return ThClassificationOption;
    }
]);


treeherder.controller('ThClassificationOptionController', [
    '$scope',
    function ($scope) {
        var ctrl = this;
        var line;

        ctrl.$onChanges = (changes) => {
            console.log('ThClassificationOptionController.$onChanges', ctrl, changes);
            console.log(ctrl.selected);
            console.log(ctrl.option);
            $scope.line = ctrl.line;
            $scope.selected = ctrl.selected;
            $scope.option = ctrl.option;
        };

        $scope.onChange = () => {
            console.log("change");
            console.log(ctrl.onChange);
            ctrl.onChange();
        };
    }
]);

treeherder.component('thClassificationOption', {
    templateUrl: 'plugins/auto_classification/option.html',
    controller: 'ThClassificationOptionController',
    bindings: {
        line: '<',
        option: '<',
        selected: '=',
        onChange: '&'
    }
});

treeherder.controller('ThErrorActionsController', [
    '$scope',
    function ($scope) {
        var ctrl = this;

        $scope.model = {value: null};
        ctrl.$onChanges = (changes) => {
            console.log('ThErrorActionsController.changes', ctrl, changes);
            $scope.actionOptions = actionOptions();
            console.log("actionOptions", $scope.actionOptions);
        };

        $scope.onChange = function() {
            ctrl.onChange({value: $scope.model.value});
        };

        function actionOptions() {
            var type = ctrl.currentOption.type;
            if(ctrl.currentOption.isBest && !ctrl.currentOption.data.best_classification.bug_number) {
                return ["Update", "Create"];
            } else if (ctrl.currentOption.isBest) {
                return ["Verify"];
            } else if (type === "classified_failure") {
                return ["Reclassify"];
            } else if (type === "unstructured_bug" ||
                       type === "manual") {
                // This is strictly untrue; we might reclassify if there's a
                // classified failure with the same bug number that the autoclassifier
                // didn't pick up at all.
                return ["Create"];
            }
            return [""];
        };
    }
]);

treeherder.component('thErrorActions', {
    templateUrl: 'plugins/auto_classification/errorActions.html',
    controller: 'ThErrorActionsController',
    bindings: {
        loggedIn: '<',
        currentOption: '<',
        onChange: '&'
    }
});

treeherder.controller('ThErrorLineController', [
    '$scope', '$rootScope', 'thEvents', 'thValidBugNumber', 'ThClassificationOption', 'thStringOverlap',
    function ($scope, $rootScope, thEvents, thValidBugNumber, ThClassificationOption, thStringOverlap) {
        var ctrl = this;
        var line;
        var optionsById;
        var bestOption;

        $scope.showHidden = false;

        ctrl.$onChanges = (changes) => {
            console.log("ThErrorLineController.$onChanges", ctrl, changes);
            var changed = x => changes.hasOwnProperty(x);
            if (changed("matchers") || changed("line")) {
                build();
            }
            $scope.loggedIn = ctrl.loggedIn;
            $scope.canSave = ctrl.loggedIn;
            $scope.verified = line.data.best_is_verified;
            $scope.failureLine = line.data.failure_line;
            $scope.searchLine = line.data.bug_suggestions.search;
        };

        function build() {
            line = $scope.line = ctrl.line;
            $scope.options = getOptions();
            console.log("options", $scope.options);
            $scope.extraOptions = getExtraOptions($scope.options);

            var allOptions = $scope.options.concat($scope.extraOptions);

            optionsById = allOptions.reduce((byId, option) => {
                byId.set(option.id, option);
                return byId;
            }, new Map());

            var defaultOption = getDefaultOption($scope.options,
                                                 $scope.extraOptions);
            console.log("defaultOption", defaultOption);
            $scope.selectedOption = {id: defaultOption.id,
                                     manualBugNumber: ""};
            console.log("options", $scope.options);
            ctrl.state = null;
            $scope.optionChanged();
        };

        function currentOption() {
            return optionsById.get($scope.selectedOption.id);
        };

        function optionData() {
            var option = currentOption();
            var bug = option.type === "manual" ? $scope.selectedOption.manualBugNumber : option.bugNumber;
            return {lineId: line.id,
                    type: line.type,
                    classifiedFailureId: option.classifiedFailureId,
                    bugNumber: bug,
                    optionId: option.id};
        }

        $scope.hasHidden = function(options) {
            return options.some((option) => option.hidden);
        };

        $scope.optionChanged = function() {
            console.log("optionChanged");
            $scope.currentOption = currentOption();
            console.log($scope.currentOption);
            ctrl.onChange(optionData());
        };

        $scope.actionChanged = function(value) {
            console.log("actionChanged");
            var data = optionData();
            if (value == "Create") {
                // If we have a classified failure with no existing bug
                // and we opt to create rather than update then set the
                // classifiedFailureId to null so we will create a new classified
                // failure with the given bug
                data.classifiedFailureId = null;
            }
            ctrl.onChange(data);
        };

        function getOptions() {
            var bugSuggestions = [].concat(
                line.data.bug_suggestions.bugs.open_recent,
                line.data.bug_suggestions.bugs.all_others);

            var classificationMatches = getClassifiedFailureMatcher();

            var autoclassifyOptions = line.data.classified_failures
                    .filter((cf) => cf.bug_number != null && cf.bug_number != 0)
                    .map((cf) => new ThClassificationOption("classifiedFailure",
                                                            line.id + "-" + cf.id,
                                                            cf.id,
                                                            cf.bug_number,
                                                            cf.bug ? cf.bug.summary : "",
                                                            cf.bug ? cf.bug.resolution : "",
                                                            classificationMatches(cf.id)));

            var autoclassifiedBugs = line.data.classified_failures
                    .reduce(function(classifiedBugs, cf) {
                        if (cf.bug_number) {
                            classifiedBugs.add(cf.bugNumber);
                        };
                        return classifiedBugs;
                    }, new Set());

            var bugSuggestionOptions = bugSuggestions
                    .filter((bug) => !autoclassifiedBugs.has(bug.id))
                    .map((bugSuggestion) => new ThClassificationOption("unstructuredBug",
                                                                       line.id + "-" + "ub-" + bugSuggestion.id,
                                                                       null,
                                                                       bugSuggestion.id,
                                                                       bugSuggestion.summary,
                                                                       bugSuggestion.resolution));

            bestOption = null;

            // Look for an option that has been marked as the best classification.
            // This is always sorted first and never hidden, so we remove it and readd it.
            if (!bestIsIgnore()) {
                var bestIndex = line.data.best_classification ?
                        autoclassifyOptions
                        .findIndex((cf) => cf.id = line.data.best_classification) : -1;

                if (bestIndex > -1) {
                    bestOption = autoclassifyOptions[bestIndex];
                    bestOption.isBest = true;
                    autoclassifyOptions.splice(bestIndex, 1);
                }
            }

            var options = autoclassifyOptions.concat(bugSuggestionOptions);
            scoreOptions(options);
            sortOptions(options);

            if (bestOption) {
                options.unshift(bestOption);
            }

            markHidden(options);

            return options;
        }

        function getExtraOptions(options) {
            var extraOptions = [];
            // Don't add a manual option if the autoclassifier picked an option
            // with no bug number
            if (!bestOption || bestOption.bugNumber !== null) {
                extraOptions.push(new ThClassificationOption("manual", line.id + "-manual"));
            }
            var ignoreOption = new ThClassificationOption("ignore", line.id + "-ignore", 0);
            extraOptions.push(ignoreOption);
            if (bestIsIgnore()) {
                ignoreOption.isBest = true;
            }
            return extraOptions;
        }

        function bestIsIgnore() {
            return (line.data.best_classification &&
                    line.data.best_classification.bugNumber == 0);
        }

        function scoreOptions(options) {
            options
                .forEach((option) => {
                    var score;
                    if (options.matches) {
                        score = this.matches
                            .reduce((prev, cur) => cur.score > prev ? cur : prev, 0);
                    } else {
                        score = thStringOverlap(line.data.bug_suggestions.search,
                                                option.bugSummary);
                        // Artificially reduce the score of resolved bugs
                        score *= option.bugResolution ? 0.8 : 1;
                    }
                    option.score = score;
                });
        }

        function sortOptions(options) {
            // Sort all the possible failure line options by their score
            options.sort((a, b) => b.score - a.score);
        }

        function markHidden(options) {
            // Mark some options as hidden by default
            // We do this if the score is too low compared to the best option
            // of if the score is below some threshold or if there are too many
            // options

            console.log("markHidden");
            if (!options.length) {
                return;
            }

            var bestOption = options[0];

            console.log(bestOption);

            var lowerCutoff = 0.1;
            var bestRatio = 0.5;
            var maxOptions = 10;
            var minOptions = 3;

            var bestScore = bestOption.score;

            options.forEach((option, idx) => {
                option.hidden = idx > (minOptions - 1) &&
                    (option.score < lowerCutoff ||
                     option.score < bestRatio * bestScore ||
                     idx > (maxOptions - 1));
                console.log("Hidden", option, option.hidden);
            });
        }

        function getClassifiedFailureMatcher() {
            var matchesByClassifiedFailure = new Map();

            var matchesByCF = line.data.matches.reduce(
                function(matchesByCF, match) {
                    if (!matchesByCF.has(match.classified_failure)) {
                        matchesByCF.set(match.classified_failure, []);
                    }
                    matchesByCF.get(match.classified_failure).push(match);
                    return matchesByCF;
                }, new Map());

            return function(cf_id) {
                return matchesByCF.get(cf_id).map(
                    function(match) {
                        return {
                            matcher: ctrl.matchers[match.matcher],
                            score: match.score
                        };
                    });
            };
        }

        function getDefaultOption(options, extraOptions) {
            if (bestOption) {
                return bestOption;
            }
            if (!options.length) {
                return extraOptions[0];
            }
            return options[0];
        }

        ctrl.onEventIgnore = function() {
            if (!ctrl.selected) {
                return;
            }
            var id = line.id + "-ignore";
            if (id !== $scope.selectedOption.id) {
                $scope.selectedOption.id = id;
                $scope.optionChanged();
            }
        };

        ctrl.onEventSelectOption = function(option) {
            if (!ctrl.selected) {
                return;
            }
            var id;
            if (option === "=") {
                id = line.id + "-manual";
            } else {
                var idx = parseInt(option);
                if ($scope.options[idx]) {
                    id = $scope.options[idx].id;
                }
            }
            if (!optionsById.has(id)) {
                return;
            }
            if (id !== $scope.selectedOption.id) {
                $scope.selectedOption.id = id;
                $scope.optionChanged();
            }
            if (option == "=") {
                $("#" + line.id + "-manual-bug").focus();
            }
        };

        ctrl.onEventToggleExpandOptions = function() {
            console.log("onToggleExpandOptions", ctrl.selected);
            if (!ctrl.selected) {
                return
            }
            $scope.showHidden = !$scope.showHidden;
        };

        $rootScope.$on(thEvents.autoclassifySelectOption,
                       (ev, key) => ctrl.onEventSelectOption(key));

        $rootScope.$on(thEvents.autoclassifyIgnore,
                       () => ctrl.onEventIgnore());

        $rootScope.$on(thEvents.autoclassifyToggleExpandOptions,
                       () => ctrl.onEventToggleExpandOptions());
    }
]);

treeherder.component('thErrorLine', {
    templateUrl: 'plugins/auto_classification/errorLine.html',
    controller: 'ThErrorLineController',
    bindings: {
        matchers: '<',
        line: '<',
        loggedIn: '<',
        selected: '<',
        onChange: '&'
    }
});

treeherder.controller('ThAutoclassifyErrorsController', ['$scope', '$element',
    function ($scope, $element) {
        var ctrl = this;

        ctrl.$onChanges = function(changes) {
            console.log("thAutoclassifyErrorsController.$onChange", ctrl, changes);
        };

        $scope.toggleSelect = function(event, id) {
            console.log(event);
            var target = $(event.target);
            var elem = target;
            var interactive = new Set(["INPUT", "BUTTON", "TEXTAREA", "A"]);
            while(elem.length && elem[0] !== $element[0]) {
                if (interactive.has(elem.prop("tagName"))) {
                    return;
                }
                elem = elem.parent();
            }
            ctrl.onToggleSelect({lineId: id, clear: !event.ctrlKey});
        };
    }
]);

treeherder.component('thAutoclassifyErrors', {
    templateUrl: 'plugins/auto_classification/errors.html',
    controller: "ThAutoclassifyErrorsController",
    bindings: {
        status: '<',
        matchers: '<',
        lines: '=',
        loggedIn: '<',
        selected: '<',
        onUpdateLine: '&',
        onToggleSelect: '&'
    }
});

treeherder.controller('ThAutoclassifyToolbarController', [
    function() {
        var ctrl = this;

        ctrl.$onChanges = function(changes) {
            console.log("thAutoclassifyToolbarController.$onChanges", ctrl, changes);
        };
    }
]);

treeherder.component('thAutoclassifyToolbar', {
    templateUrl: 'plugins/auto_classification/toolbar.html',
    controller: "ThAutoclassifyToolbarController",
    bindings: {
        status: '<',
        autoclassifyStatus: '<',
        canSaveAll: '<',
        selected: '<',
        loggedIn: '<',
        onSaveAll: '&',
        onIgnore: '&',
        onSave: '&'
    }
});

treeherder.controller('ThAutoclassifyPanelController', [
    '$scope', '$rootScope', '$q', '$timeout', 'thEvents', 'thJobNavSelectors', 'ThMatcherModel',
    'ThTextLogErrorsModel', 'ThErrorLineData',
    function($scope, $rootScope, $q, $timeout, thEvents, thJobNavSelectors, ThMatcherModel,
             ThTextLogErrorsModel, ThErrorLineData) {

        var ctrl = this;

        var requestPromise = null;

        var linesById = null;

        var autoclassifyStatusOnLoad = null;

        ctrl.$onChanges = (changes) => {
            var changed = x => changes.hasOwnProperty(x);
            console.log("thAutoclassifyPanelController.$onChanges", ctrl, changes);

            $scope.loggedIn = (ctrl.user && ctrl.user.loggedin);

            if (changed("job")) {
                if (ctrl.job.id) {
                    jobChanged();
                }
            } else if (changed("hasLogs") || changed("logsParsed") ||
                       changed("logParseStatus") || changed("autoclassifyStatus")) {
                build();
            }
        };

        function jobChanged() {
            linesById = new Map();
            ctrl.selected = new Set();
            autoclassifyStatusOnLoad = null;
            build();
        }

        function build() {
            console.log("thAutoclassifyPanelController.build", ctrl);
            console.log("Status", ctrl.status);
            if (!ctrl.logsParsed || ctrl.autoclassifyStatus === "pending") {
                ctrl.status = "pending";
            } else if (ctrl.logParsingFailed) {
                ctrl.status = "failed";
            } else if (!ctrl.hasLogs) {
                ctrl.status = "no_logs";
            } else if ((autoclassifyStatusOnLoad === null ||
                        autoclassifyStatusOnLoad === "cross_referenced")) {
                if (ctrl.status !== "ready") {
                    ctrl.status = "loading";
                }
                fetchErrorData()
                    .then(data => buildLines(data))
                    .catch((err) => {
                        console.log("load failed");
                        console.log(err);
                        ctrl.status = "error";
                    });
            };
        }

        function buildLines(data) {
            console.log(data);
            $scope.matchers = data.matchers;
            loadData(data.error_lines);
            requestPromise = null;
            ctrl.status = "ready";
            // Store the autoclassify status so that we only retry
            // the load when moving from 'cross_referenced' to 'autoclassified'
            autoclassifyStatusOnLoad = ctrl.autoclassifyStatus;
            // Preselect the first line
            if ($scope.errorLines.length) {
                ctrl.selected.add($scope.errorLines[0].id);
            }
        }

        function fetchErrorData() {
            // if there's a ongoing request, abort it
            if (requestPromise !== null) {
                requestPromise.resolve();
            }

            requestPromise = $q.defer();

            console.log("making request", ctrl.job);
            var resources = {
                "matchers": ThMatcherModel.by_id(),
                "error_lines": ThTextLogErrorsModel.getList(ctrl.job.id,
                                                            {timeout: requestPromise})
            };
            return $q.all(resources);
        }

        function loadData(lines) {
            console.log("loadData", lines);
            linesById = lines
                .reduce((byId, line) => {
                    byId.set(line.id,  new ThErrorLineData(line));
                    return byId;}, linesById);
            $scope.errorLines = Array.from(linesById.values());
            // Resort the lines to allow for in-place updates
            $scope.errorLines.sort((a, b) => b.data.id - a.data.id);
        }

        ctrl.onSaveAll = function() {
            save(pendingLines());
        };

        ctrl.onSave = function() {
            save(selectedLines());
        };

        ctrl.onIgnore = function() {
            $rootScope.$emit(thEvents.autoclassifyIgnore);
        };

        ctrl.onUpdateLine = function(lineId, type, classifiedFailureId, bugNumber, optionId) {
            console.log("onUpdateLine");
            linesById.get(lineId).state = {
                type: type,
                classifiedFailureId: classifiedFailureId,
                bugNumber: bugNumber
            };
        };

        ctrl.onToggleSelect = function(lineId, clear) {
            console.log("thAutoclassifyPanelController.onSelectLine", lineId);
            var isSelected = ctrl.selected.has(lineId);
            if (clear) {
                ctrl.selected.clear();
            }
            if (isSelected) {
                ctrl.selected.delete(lineId);
            } else {
                ctrl.selected.add(lineId);
            }
            console.log(ctrl.selected);
        };

        ctrl.onChangeSelection = function(direction, clear) {
            console.log("onChangeSelection", direction, clear);
            var optionIndexes = $scope.errorLines
                    .reduce((idxs, x, i) => idxs.set(x.id, i), new Map());
            var selected = selectedLines();
            console.log("onChangeSelection", optionIndexes, selected);
            var idx;
            if (direction === "next") {
                if (selected) {
                    idx = optionIndexes.get(selected[selected.length - 1].id) + 1;
                } else {
                    idx = 0;
                }
            } else if (direction === "previous") {
                if (selected) {
                    idx = optionIndexes.get(selected[0].id) - 1;
                } else {
                    idx = -1;
                }
            }
            console.log("onChangeSelection", idx);
            if (clear) {
                // Move to the next or previous panels if we moved out of bounds
                if (idx > $scope.errorLines.length - 1) {
                    $rootScope.$emit(thEvents.changeSelection,
                                     'next',
                                     thJobNavSelectors.UNCLASSIFIED_FAILURES);
                    return;
                } else if (idx < 0) {
                    $rootScope.$emit(thEvents.changeSelection,
                                     'previous',
                                     thJobNavSelectors.UNCLASSIFIED_FAILURES);
                    return;
                }
            }
            var lineId = $scope.errorLines[idx].id;
            ctrl.onToggleSelect(lineId, clear);
            $("th-autoclassify-errors th-error-line")[idx].scrollIntoView();
        };

        $scope.canSaveAll = function() {
            //TODO
            return $scope.loggedIn; //&& pendingLines.each(line => )
        };

        function save(lines) {
            var data = lines.map((line) => {
                var bestClassification = line.state.classifiedFailureId;
                var bugNumber = line.state.bugNumber;
                return {id: line.id,
                        best_classification: bestClassification,
                        bug_number: bestClassification};
                    });
            console.log("save", data);
            ThTextLogErrorsModel
                .verifyMany(data)
                .then((new_lines) => loadData(new_lines));
        };

        function pendingLines() {
            return $scope.errorLines
                .filter((line) => !line.data.best_is_verified === false);
        }

        function selectedLines() {
            return $scope.errorLines
                .filter((line) => ctrl.selected.has(line.id));
        }

        $rootScope.$on(thEvents.autoclassifyChangeSelection,
                       (ev, direction, clear) => ctrl.onChangeSelection(direction, clear));
}]);

treeherder.component('thAutoclassifyPanel', {
    templateUrl: 'plugins/auto_classification/panel.html',
    controller: 'ThAutoclassifyPanelController',
    bindings: {
        job: '<',
        hasLogs: '<',
        logsParsed: '<',
        logParseStatus: '<',
        autoclassifyStatus: '<',
        user: '<'
    }
});
