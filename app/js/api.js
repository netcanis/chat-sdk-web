/**
 * Created by benjaminsmiley-andrews on 26/05/15.
 */

var myApp = angular.module('myApp.api', []);

myApp.factory('Authentication', ['$q', '$http', '$window', '$timeout', 'Config', 'LocalStorage', 'Paths', 'Utils', 'SingleSignOn',
    function ($q, $http, $window, $timeout, Config, LocalStorage, Paths, Utils, SingleSignOn) {
        var Authentication = {

            mode: bLoginModeSimple,
            getToken: null,
            authListener: null,

            init: function () {

                // Is there a valid get token in the URL?
                var pairs = $window.location.search.replace("?", "").split("&");
                for(var i = 0; i < pairs.length; i++) {
                    var values = pairs[i].split("=");
                    if(values.length == 2) {
                        if(values[0] == "cc_token") {
                            this.getToken = values[1];
                            this.mode = bLoginModeToken;
                            break;
                        }
                    }
                }

                if(!this.getToken) {
                    // Setup the login and register URLs
                    var ssoURL = Config.singleSignOnURL;
                    if(ssoURL && ssoURL.length > 0) {
                        this.mode = bLoginModeSingleSignOn;
                    }

                }

                return this;
            },

            setAuthListener: function (callback) {
                this.authListener = callback;
            },

            modeIs: function (mode) {
                return this.mode == mode;
            },

            startAuthListener: function () {

                var deferred = $q.defer();

                var ref = Paths.firebase();

                var auth = ref.getAuth();

                if(this.modeIs(bLoginModeToken)) {
                    // This process should result in one of two outcomes
                    if(auth) {
                        if(this.getToken != auth.token) {
                            ref.unauth();
                            deferred.resolve(this.authenticateWithToken());
                        }
                        else {
                            deferred.resolve(null);
                        }
                    }
                    else {
                        deferred.resolve(this.authenticateWithToken());
                    }
                }
                // We always unauth with SSO
                else if (this.modeIs(bLoginModeSingleSignOn)) {
                    ref.unauth();
                    deferred.resolve(this.authenticateWithSSO());
                }
                // We unauth with simple login if the token has a custom provider
                else {
                    // The user is using simple sign on and they're authenticated
                    if(auth && auth.provider != bProviderTypeCustom) {
                        deferred.resolve(auth);
                    }
                    else {
                        ref.unauth();
                        deferred.resolve(null);
                    }
                }

//            if(auth) {
//                else {
//                    deferred.resolve(auth);
//                    if(callback) {
//                        callback(auth);
//                    }
//                    return deferred.promise;
//                }

                // If we're using token auth and the token is different
                // to the one stored then unauth
                ref.onAuth((function(authData) {
                    if(this.authListener) {
                        this.authListener(authData);
                    }
                }).bind(this));

                return deferred.promise;
            },

            ssoAttempts: 0,
            authenticateWithSSO: function () {

                var ref = Paths.firebase();
                var deferred = $q.defer();

                var retry = (function (deferred, error) {
                    if(this.ssoAttempts == 0) {
                        this.ssoAttempts++;
                        SingleSignOn.invalidate();
                        deferred.resolve(this.authenticateWithSSO());
                    }
                    else {
                        deferred.reject(error);
                    }
                }).bind(this);

                SingleSignOn.authenticate().then((function (data) {
                    ref.authWithCustomToken(data.token, (function(error, result) {
                        if(!error) {
                            result.thirdPartyData = data;
                            deferred.resolve(result);
                        }
                        else {
                            retry(deferred, error);
                        }
                    }).bind(this));
                }).bind(this), (function (error) {
                    retry(deferred, error);
                }).bind(this));

                return deferred.promise;
            },

            authenticateWithToken: function () {

                var ref = Paths.firebase();
                var deferred = $q.defer();

                ref.authWithCustomToken(this.getToken, (function(error, result) {
                    if(!error) {
                        deferred.resolve(result);
                    }
                    else {
                        deferred.reject(error);
                    }
                }).bind(this));

                return deferred.promise;
            }

        };
        return Authentication.init();
    }
]);

myApp.factory('SingleSignOn', ['$rootScope', '$q', '$http', 'Config', 'LocalStorage', 'Utils',
    function ($rootScope, $q, $http, Config, LocalStorage, Utils) {

    // API Levels

    // 0: Client makes request to SSO server every time chat loads
    // each time it requests a new token

    // 1: Introduced user token caching - client first makes request
    // to get user's ID. It only requests a new token if the ID has
    // changed

    return {

        defaultError: "Unable to reach server",
        busy: false,

        getAPILevel: function () {
            var level = Config.singleSignOnAPILevel;

            if(Utils.unORNull(level)) {
                level = 0;
            }

            return level;
        },

        invalidate: function () {
            LocalStorage.removeProperty(LocalStorage.tokenKey);
            LocalStorage.removeProperty(LocalStorage.tokenExpiryKey);
            LocalStorage.removeProperty(LocalStorage.UIDKey);
        },

        authenticate: function () {

            var url = Config.singleSignOnURL;

            this.busy = true;
            switch (this.getAPILevel()) {
                case 0:
                    return this.authenticateLevel0(url);
                    break;
                case 1:
                    return this.authenticateLevel1(url);
                    break;
            }
        },

        authenticateLevel0: function (url) {

            var deferred = $q.defer();

            this.executeRequest({
                method: 'get',
                params: {
                    action: 'cc_auth'
                },
                url: url
            }).then((function (data) {

                // Update the config object with options that are set
                // These will be overridden by options which are set on the
                // config tab of the user's Firebase install
                Config.setConfig(Config.setBySingleSignOn, data);


                this.busy = false;
                deferred.resolve(data);

            }).bind(this), (function (error) {
                this.busy = false;
                deferred.reject(error);
            }).bind(this));

            return deferred.promise;
        },

        authenticateLevel1: function (url, force) {

            //this.invalidate();

            var deferred = $q.defer();

            // Get the current user's information
            this.getUserUID(url).then((function (response) {

                var currentUID = response.uid;

                // Check to see if we have a token cached
                var token = LocalStorage.getProperty(LocalStorage.tokenKey);
                var expiry = LocalStorage.getProperty(LocalStorage.tokenExpiryKey);
                var uid = LocalStorage.getProperty(LocalStorage.UIDKey);

                // If any value isn't set or if the token is expired get a new token
                if(!Utils.unORNull(token) && !Utils.unORNull(expiry) && !Utils.unORNull(uid) && !force) {
                    // Time since token was refreshed...
                    var timeSince = new Date().getTime() - expiry;
                    // Longer than 20 days
                    if(timeSince < 60 * 60 * 24 * 20 && uid == currentUID) {

                        Config.setConfig(Config.setBySingleSignOn, response);

                        this.busy = false;
                        response['token'] = token;
                        deferred.resolve(response);
                        return deferred.promise;
                    }
                }

                this.executeRequest({
                    method: 'get',
                    params: {
                        action: 'cc_get_token'
                    },
                    url: url
                }).then((function (data) {

                    // Cache the token and the user's current ID
                    LocalStorage.setProperty(LocalStorage.tokenKey, data.token);
                    LocalStorage.setProperty(LocalStorage.UIDKey, currentUID);
                    LocalStorage.setProperty(LocalStorage.tokenExpiryKey, new Date().getTime());

                    // Update the config object with options that are set
                    // These will be overridden by options which are set on the
                    // config tab of the user's Firebase install
                    Config.setConfig(Config.setBySingleSignOn, data);

                    this.busy = false;
                    deferred.resolve(data);

                }).bind(this), (function (error) {
                    this.busy = false;
                    deferred.reject(error);
                }.bind(this)));

            }).bind(this), deferred.reject);

            return deferred.promise;
        },

        getUserUID: function (url) {

            return this.executeRequest({
                method: 'get',
                params: {
                    action: 'cc_get_uid'
                },
                url: url
            });
        },

        executeRequest: function (params) {

            var deferred = $q.defer();

            $http(params).then((function (r) {
                if(r && r.data && r.status == 200) {
                    if(r.data.error) {
                        deferred.reject(r.data.error);
                    }
                    else {
                        deferred.resolve(r.data);
                    }
                }
                else {
                    deferred.reject(this.defaultError);
                }
            }).bind(this), function (error) {
                deferred.reject(error.message ? error.message : this.defaultError);
            });

            return deferred.promise;
        }
    };

}]);