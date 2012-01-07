'use strict';

var express = require( 'express' ),
    app = express.createServer(),
    async = require( 'async'),
    crypto = require( 'crypto' ),
    fs = require( 'fs' ),
    Git = require( './lib/git'),
    exec = require( 'child_process' ).exec,
    path = require( 'path' ),
    regexp = require( './lib/regexp' ),
	requirejs = require( 'requirejs' ),
    requirejs_edge = require( './lib/r-edge.js' ),
    rimraf = require( 'rimraf' );

var httpPort = process.env.PORT || 8080,
    repoBaseDir = path.normalize( process.env.REPO_BASE_DIR ),
    workBaseDir = path.normalize ( process.env.WORK_BASE_DIR ),
    filters = {};

app.configure('development', function(){
    app.use( express.errorHandler({ dumpExceptions: true, showStack: true }) );
    app.use( express.logger( 'tiny' ) );
});

app.configure('production', function(){
});

app.use(express.bodyParser());

app.get( '/', function ( req, res ) {
    res.send( "<h1 style='text-align: center; font-size: 120px;'>ZOMG JQM-BUILDER</h1>" );
});

function fetch( repoDir, callback ) {
    Git( repoDir );
    Git.exec( [ "fetch" ], callback );
}

function cleanup( repo, ref, callback ) {
    var compiled = getCompiledDirSync( repo, ref );

    async.series([
        function( next ) {
            rimraf( compiled, next );
        },
        function( next ) {
            fs.mkdir( compiled, next );
        },
        function( next ) {
            var wsDir = getWorkspaceDirSync( repo, ref ),
                filterPath;
            for ( filterPath in filters[ wsDir ] ) {
                delete require.cache[ filterPath ];
                delete filters[ wsDir ][ filterPath ];
            }
            next( null );
        }
    ], function( err, results ) {
        if ( err )  {
            callback( err );
        } else {
            callback( null );
        }
    });

}

function checkout( repoName, repoDir, ref, force, callback ){
    if ( typeof force === "function" ) {
        callback = force;
        force = false;
    }
    if (!repoName) throw new Error( "No repo name specified" );
    if (!repoDir) throw new Error( "No repo dir specified" );
    if (!callback) throw new Error( "No callback passed to checkout()" );
    if (!ref) {
        ref = "master";
    }

    // Workspace
    var wsDir  = getWorkspaceDirSync( repoName, ref );

    path.exists( wsDir, function( exists ) {
        if ( exists || force ) {
            async.series([
                function( next ) {
                    fs.mkdir( wsDir, function( err ) {
                        if ( err && err.code != "EEXIST" ) {
                            next( err );
                        } else {
                            next( null );
                        }
                    });
                },
                function( next ) {
                    Git( repoDir, wsDir );
                    Git.exec( [ "checkout", "-f", ref ], next );
                },
                function( next ) {
                    cleanup( repoName, ref, next );
                }
            ], function( err ) {
                if ( err ) {
                    callback( err );
                } else {
                    callback( null );
                }
            });
        } else {
            callback( "Worspace for " + repoName + "/" + ref + " has not been created" );
        }
    });
}

function getFirstExistingDir( candidates, callback ) {
    var dir = candidates.shift();
    path.exists( dir , function( exists ) {
        if ( exists ) {
            callback( null, dir );
        } else {
            if ( candidates.length ) {
                getFirstExistingDir( candidates, callback );
            } else {
                callback( "none found" );
            }
        }
    });
}

function getRepoDir( repo, callback ) {
    var repoDir = repoBaseDir + "/" + repo;
    getFirstExistingDir( [ repoDir, repoDir + ".git" ], callback );
}

function getWorkspaceDirSync( repo, ref ) {
    return workBaseDir + "/" + repo + "." + ref;
}

function getCompiledDirSync( repo, ref ) {
    return getWorkspaceDirSync( repo, ref ) + "/__compiled";
}

app.get( '/:repo/fetch', function ( req, res ) {
    async.waterfall([
        function( callback ) {
            getRepoDir( req.params.repo, callback )
        },
        fetch,
        function ( out ) {
            res.send( out );
        }
    ], function( err ) {
        if ( err ) {
            res.send( err, 500 );
        }
    })
});

app.post( '/post_receive', function ( req, res ) {
    var payload = req.body.payload,
        repoName, repoDir, ref,
        fetchIfExists = function( candidates, callback ) {
            var dir = candidates.shift();
            path.exists( dir , function( exists ) {
                if ( exists ) {
                    fetch( dir,
                        function ( error, stdout, stderr ) {
                            if ( error !== null ) {
                                res.send( error, 500 );
                            } else {
                                callback( dir );
                            }
                        }
                    );
                } else {
                    if ( candidates.length ) {
                        fetchIfExists( candidates );
                    } else {
                        res.send( "Workspace for '" + repoName + "' hasn't been checked out", 404 );
                    }
                }
            });
        };

    if ( payload ) {
        try {
            payload = JSON.parse( payload );
            repoName = payload.repository.name;
            ref = payload.ref.split( "/" ).pop();

            if ( payload.repository && payload.repository.name ) {
                async.waterfall([
                    function( callback ){
                        getRepoDir( repoName, callback );
                    },
                    function( dir, callback ) {
                        repoDir = dir;
                        fetch( dir, callback );
                    },
                    function( out, callback ) {
                        checkout( repoName, repoDir, ref, callback );
                    }//,
//                    function( out, callback ) {
//                        var compiled = getCompiledDirSync( repoName, tag );
//                        async.series([
//                            function( cb ) {
//                                rimraf( compiled, cb );
//                            },
//                            function( cb ) {
//                                fs.mkdir( compiled, cb );
//                            }
//                        ], function( err, results ) {
//                            if ( err )  {
//                                callback( err );
//                            } else {
//                                callback( null, out );
//                            }
//                        });
//                    }
                ],
                function ( err, result ) {
                    if ( err ) {
                        res.send( err, 500 );
                    } else {
                        res.send( "OK" );
                    }
                });
            } else {
                res.send( "Payload is missing data", 404 );
            }
        } catch( e ) {
            res.send( e, 500 );
        }
    } else {
        res.send( "No Payload!", 400 );
    }
});

app.get( '/:repo/:ref/checkout', function ( req, res ) {
    var repoName = req.params.repo,
        ref      = req.params.ref;

    async.waterfall([
        function( callback ) {
            getRepoDir( repoName, callback )
        },
        function( repoDir, callback ) {
            checkout( repoName, repoDir, ref, callback );
        }

    ], function( err ) {
        if ( err ) {
            res.send( err, 500 );
        } else {
            res.send( "OK" );
        }
    });
});

app.get( '/:repo/:ref/make', function ( req, res ) {
    var include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = req.param( "optimize", "none" ),
        baseUrl = req.param( "baseUrl", "." ),
        pragmas = JSON.parse( req.param( "pragmas", "{}" ) ),
        pragmasOnSave = JSON.parse( req.param( "pragmasOnSave", "{}" ) ),
        name = path.basename( req.param( "name", req.params.repo ), ".js" ),
        filter = req.param( "filter" ),
        shasum = crypto.createHash( 'sha1' ),
        wsDir   = getWorkspaceDirSync( req.params.repo, req.params.ref ),
        dstDir, dstFile;

    // var baseUrlFilters[baseUrl] = require(path.join(baseUrl, 'somemagicnameOrpackage.jsonEntry.js'));
	//Set up the config passed to the optimizer
	var config = {
		baseUrl: path.join( wsDir, baseUrl ),
		include: include,
        pragmas: pragmas,
        pragmasOnSave: pragmasOnSave
	};

    shasum.update( JSON.stringify( config ) );
    shasum.update( filter );

    dstDir = path.join( getCompiledDirSync( req.params.repo, req.params.ref ), shasum.digest( 'hex' ) );
    dstFile = path.join( dstDir, name + (optimize !== "none" ? ".min" : "") + ".js" );

    config.out = dstFile;
    config.optimize = optimize;

    path.exists( dstFile, function ( exists ) {
        if ( exists ) {
            res.download( dstFile, path.basename( dstFile ) );
        } else {
            try {
				requirejs.optimize( config, function ( buildResponse ) {
					//buildResponse is just a text output of the modules
					//included. Load the built file for the contents.
					fs.readFile( config.out, 'utf8', function( err, contents ) {
                        if ( err ) throw err;
                        var filterPath = path.join( config.baseUrl, filter );
                        if ( filter ) {
                            filters[ wsDir ] = filters[ wsDir ] || {};
                            filters[ wsDir ][ filterPath ] = require( filterPath );
                            contents = filters[ wsDir ][ filterPath ]( contents );
                        }
                        fs.writeFile( config.out, contents, 'utf8',
                            function( err ) {
                                if ( err ) throw err;
                                res.send( contents );
                            }
                        );
					});
				});
			} catch ( e ) {
				res.send( e.toString(), 500 );
			}
        }
    });
});

app.get( '/:repo/:ref/dependencies', function ( req, res ) {
    var wsDir = getWorkspaceDirSync( req.params.repo, req.params.ref ),
        names = req.param( "names", "" ).split( "," ).filter( function(name) {return !!name} ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        baseUrl = path.normalize( path.join( wsDir, req.param( "baseUrl", "." ) ) ),
        shasum = crypto.createHash( 'sha1' ),
        compileDir = getCompiledDirSync( req.params.repo, req.params.ref ),
        filename = compileDir + "/deps-";

    async.waterfall([
        function( callback ) {
            // If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
            if ( names.length ) {
                callback( null );
            } else {
                fs.readdir(baseUrl, function( err, files ) {
                    if ( err ) {
                        callback( err );
                    } else {
                        files = files.filter( function( file ) { return path.extname( file ) === ".js" } );
                        names = files.map( function( file ) { return path.basename( file, ".js" ) } );

                        callback( null );
                    }
                });
            }
        },
        function( callback ) {
            // Generate a sha on the sorted names
            shasum.update( names.join( "," ) );
            filename += shasum.digest( 'hex' ) + ".json";

            path.exists( filename, function( exists ) {
                callback( null, exists )
            });
        },
        function( exists, callback ) {
            if ( exists ){
                res.header( "Access-Control-Allow-Origin", "*");
                res.sendfile( filename );
            } else {
                async.waterfall([
                    function( cb ) {
                        fs.mkdir( compileDir, function( err ) {
                            if ( err && err.code != "EEXIST" ) {
                                cb( err );
                            } else {
                                cb( null );
                            }
                        });
                    },
                    function( cb ) {
                        requirejs_edge.tools.useLib(function (require) {
                            require(['parse'], function (parse) {
                                cb( null, parse );
                            })
                        });
                    },
                    function( parse, cb ) {
                        var deps = {};
                        names.forEach(function (name) {
                            var fileName = path.join( baseUrl, name + ".js" ),
                                contents = fs.readFileSync( fileName, 'utf8' );
                            deps[ name ] = {};
                            deps[ name ].deps = parse.findDependencies( fileName, contents );
                        });
                        cb( null, deps );
                    },
                    function( deps, cb ) {
                        // Walk through the dep map and remove baseUrl and js extension
                        var module,
                            modules = [],
                            baseUrlRE = new RegExp( "^" + regexp.escapeString( baseUrl + "/") ),
                            jsExtRE = new RegExp( regexp.escapeString( ".js" ) + "$" );
                        for ( module in deps ) {
                            modules.push( module );
                        }

                        async.forEach( modules,
                            function( item, callback ) {
                                async.waterfall([
                                    function( next ) {
                                        fs.readFile( path.join( baseUrl, item+".js" ), 'utf8', next );
                                    },
                                    function( data, next ) {
                                        // grep for >description & label
                                        var attributes = [ "description", "label" ];
                                        attributes.forEach( function(attr) {
                                            var attrMatchRE = new RegExp( "^.*" + regexp.escapeString( "//>>" + attr + ":") + ".*$", "m" ),
                                                attrLabelRE = new RegExp( "^.*" + regexp.escapeString( "//>>" + attr + ":") + "\\s*", "m" ),
                                                matches = data.match( attrMatchRE );
                                            if ( matches && matches.length ) {
                                                deps[ item ][ attr ] = matches[ 0 ].replace( attrLabelRE, "" ).trim();
                                            }
                                        });
                                        next();
                                    }
                                ],
                                function( err ){
                                    if ( err ) {
                                        res.send( err, 500 );
                                    } else {
                                        callback();
                                    }
                                });
                            },
                            function( err ) {
                                if ( err ) {
                                    cb( err );
                                } else {
                                    cb( null, deps );
                                }
                            }
                        )
                    },
                    function( deps, cb ){
                        fs.writeFile( filename, JSON.stringify( deps ), cb);
                        res.header( "Access-Control-Allow-Origin", "*");
                        res.json( deps );
                    }
                ],
                function( err ) {
                    if ( err ) {
                        res.send( err, 500 );
                    } else {
                        callback( null );
                    }
                })
            }
        }
    ],
    function( err ) {
        if ( err ) {
            res.send( err, 500 );
        }
    });
});

console.log( "listening on port:", httpPort );
app.listen( httpPort );