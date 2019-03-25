angular.module('myApp.controllers').controller('UserProfileBoxController', ['$scope', function($scope) {

    $scope.copyUserID = function () {

        // Get the ID
        var id = $scope.currentUser.uid();

        window.prompt("Copy to clipboard: Ctrl+C, Enter", id);
    };

}]);
