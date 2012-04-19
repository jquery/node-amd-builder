'use strict';

var _ = require( 'underscore' ),
    express = require( 'express' ),
    app = express.createServer(),
    async = require( 'async'),
    crypto = require( 'crypto' ),
    cssConcat = require( 'css-concat' ),
    fetch = require( './lib/project' ).fetch,
    fs = require( 'fs' ),
    mime = require( 'mime' ),
    path = require( 'path' ),
    Project = require( './lib/project' ).Project,
    promiseUtils = require( 'node-promise' ),
    Promise = require( 'node-promise').Promise,
    when = require( 'node-promise').when,
    regexp = require( './lib/regexp' ),
	requirejs = require( 'requirejs' ),
    url = require( 'url' ),
    zip = require("node-native-zip" );

var httpPort = process.env.PORT || 8080,
    filters = {},
    bundlePromises = {},
    dependenciesPromises = {};

app.configure('development', function(){
    app.use( express.errorHandler({ dumpExceptions: true, showStack: true }) );
    app.use( express.logger( 'tiny' ) );
});

app.configure('production', function(){
});

app.use(express.bodyParser());

function afterProjectCheckout( project ) {
    var wsDir = project.getWorkspaceDirSync(),
        filterPath;
    for ( filterPath in filters[ wsDir ] ) {
        delete require.cache[ filterPath ];
        delete filters[ wsDir ][ filterPath ];
    }
    dependenciesPromises = {};
    bundlePromises = {};
}

app.get( '/', function ( req, res ) {
    res.send( "<h1 style='text-align: center; font-size: 120px;'>GitHub based AMD web builder</h1>" );
});

app.post( '/post_receive', function ( req, res ) {
    var payload = req.body.payload,
        owner, repo, repoUrl, ref, project,
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
                        res.send( "Workspace for '" + repo + "' hasn't been checked out", 404 );
                    }
                }
            });
        };
    console.log( "post_receive(): " + payload );
    if ( payload ) {
        try {
            payload = JSON.parse( payload );
            repo = payload.repository.name;
            repoUrl = url.parse( payload.repository.url );
            owner = path.dirname( repoUrl.path ).substring( 1 );
            ref = payload.ref.split( "/" ).pop();
            project = new Project( owner, repo, ref );

            if ( project ) {
                async.series([
                    _.bind( project.fetch, project ),
                    _.bind( project.checkout, project )
                ],
                function ( err ) {
                    if ( err ) {
                        res.send( err, 500 );
                    } else {
                        afterProjectCheckout( project );
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

app.get( '/v1/:owner/:repo', function ( req, res ) {
    var project = new Project( req.params.owner, req.params.repo );
    async.waterfall([
        _.bind( project.fetch, project ),
        function ( out ) {
            res.send( ( out?"\n":"" ) + "OK" );
        }
    ], function( err ) {
        if ( err ) {
            res.send( err, 500 );
        }
    })
});

app.get( '/v1/:owner/:repo/:ref', function ( req, res ) {
    var project = new Project( req.params.owner, req.params.repo, req.params.ref );

    project.checkout(
        function( err ) {
            if ( err ) {
                res.send( err, 500 );
            } else {
                afterProjectCheckout( project );
                res.send( "OK" );
            }
        }
    );
});

var bid = 0;
function buildDependencyMap( project, baseUrl, include ) {
    var id = bid++;
    console.log( "buildDependencyMap["+id+"]()" );
    var promise = new Promise(),
        shasum = crypto.createHash( 'sha1' ),
        compileDir = project.getCompiledDirSync(),
        filename = "";

    async.waterfall([
        function( next ) {
            console.log( "buildDependencyMap["+id+"](): step 1" );
            // If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
            if ( include && include.length > 0 ) {
                next();
            } else {
                fs.readdir( baseUrl, function( err, files ) {
                    console.log( "buildDependencyMap["+id+"](): step 1.1" );
                    if ( err ) {
                        next( err );
                    } else {
                        files = files.filter( function( file ) { return path.extname( file ) === ".js" } );
                        include = files.map( function( file ) { return path.basename( file, ".js" ) } );
                        next();
                    }
                });
            }
        },
        function( next ) {
            console.log( "buildDependencyMap["+id+"](): step 2" );
            // Generate a sha on the sorted names
            var digest = shasum.update( include.join( "," ) ).digest( "hex" );

            filename += path.join(compileDir, "deps-" + digest + ".json" );

            path.exists( filename, function( exists ) {
                next( null, digest, exists )
            });
        },
        function( digest, exists, next ) {
            console.log( "buildDependencyMap["+id+"](): step 3" );
            if ( exists ){
                fs.readFile( filename, "utf8", function( err, data ) {
                    if ( err ) {
                        next( err );
                    } else {
                        next( err, JSON.parse( data ) );
                    }
                });
            } else {
                if ( !dependenciesPromises[ digest ] ) {
                    dependenciesPromises[ digest ] = promise;
                    async.waterfall([
                        function( cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.1" );
                            console.log( "mkdir '" + compileDir + "'" );
                            fs.mkdir( compileDir, function( err ) {
                                if ( err && err.code != "EEXIST" ) {
                                    cb( err );
                                } else {
                                    cb( null );
                                }
                            });
                        },
                        function( cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.2" );
                            requirejs.tools.useLib( function ( r ) {
                                r( [ 'parse' ], function ( parse ) {
                                    cb( null, parse );
                                })
                            });
                        },
                        function( parse, cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.3" );
                            var deps = {};
                            async.forEach( include, function ( name, done ) {
                                var fileName = path.join( baseUrl, name + ".js" );
                                console.log( "Processing: " + fileName );
                                fs.readFile( fileName, 'utf8', function( err, data ) {
                                    if ( err ) {
                                        callback( err );
                                    }
                                    deps[ name ] = {};
                                    deps[ name ].deps = parse.findDependencies( fileName, data );
                                    done();
                                });
                            }, function( err ) {
                                cb( err, deps );
                            });
                        },
                        function( deps, cb ) {
                            console.log( "buildDependencyMap["+id+"](): step 3.4" );
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
                                            console.log( "buildDependencyMap["+id+"](): step 3.4.1" );
                                            fs.readFile( path.join( baseUrl, item+".js" ), 'utf8', next );
                                        },
                                        function( data, next ) {
                                            console.log( "buildDependencyMap["+id+"](): step 3.4.2" );
                                            var attrMatchRE = /^.*\/\/>>\s*\w+\s*:.*$/mg,
                                                matches = data.match( attrMatchRE );
                                            if ( matches && matches.length ) {
                                                matches.forEach( function( meta ) {
                                                    var attr = meta.replace( /^.*\/\/>>\s*(\w+)\s*:.*$/, "$1" );
                                                    var attrLabelRE = new RegExp( "^.*" + regexp.escapeString( "//>>" + attr + ":") + "\\s*", "m" );
                                                    deps[ item ][ attr ] = meta.replace( attrLabelRE, "" ).trim();
                                                });
                                            }
                                            next();
                                        }
                                    ], callback );
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
                            console.log( "buildDependencyMap["+id+"](): step 3.5" );
                            fs.writeFile( filename, JSON.stringify( deps ), "utf8",
                                function( err ) {
                                    cb( err, deps );
                                }
                            );
                        }
                    ], next );
                } else {
                    dependenciesPromises[ digest ].then( function( data ) {
                        next( null, data );
                    },
                    next );
                }
            }
        }
    ], function( err, data ) {
        if ( err ) {
            promise.reject( err );
        } else {
            promise.resolve( data );
        }
    });
    return promise;
}

function applyFilter( baseUrl, filter, contents, ext, callback ) {
    if ( filter ) {
        require( path.join( baseUrl, filter ) )( contents, ext, callback );
    } else {
        callback( null, contents );
    }
}

function buildCSSBundle( project, config, name, filter, optimize ) {
    console.log( "buildCSSBundle()" );
    var promise = new Promise(),
        baseUrl = config.baseUrl,
        include = config.include,
        shasum = crypto.createHash( 'sha1' ),
        baseOut      = path.join( project.getCompiledDirSync(), name + ".css" ),
        optimizedOut = path.join( project.getCompiledDirSync(), name + ".min.css" ),
        out = optimize ? optimizedOut : baseOut;

    path.exists( out, function ( exists ) {
        if ( exists ) {
            console.log( "buildCSSBundle: resolving promise" );
            promise.resolve( out );
        } else {
            // get the dependency map for all modules
            buildDependencyMap( project, baseUrl ).then(
                function( modules ) {
                    var cssFiles = [],
                        contents =  "";

                    async.waterfall([
                        function( next ) {
                            async.forEach( include, function( module, done ) {
                                var addCssDependencies = function( m ) {
                                    m = m.replace( /^.*!/, "" );  // remove the plugin part
                                    m = m.replace( /\[.*$/, "" ); // remove the plugin arguments at the end of the path
                                    m = m.replace( /^\.\//, "" ); // remove the relative path "./"
                                    if ( modules[ m ] &&  modules[ m ].deps ) {
                                        modules[ m ].deps.forEach( addCssDependencies );
                                    }
                                    if ( modules[ m ] && modules[ m ].css ) {
                                        console.log( "Adding: " + modules[ m ].css );
                                        Array.prototype.push.apply( cssFiles, modules[ m ].css.split(",") );
                                    }
                                };
                                addCssDependencies( module );
                                done();
                            }, next )
                        },
                        function( next ) {
                            // resolve the file paths
                            cssFiles = _.uniq( cssFiles ).map( function( s ) {
                                return path.resolve( baseUrl, s.trim() );
                            });

                            cssFiles.forEach( function( file ) {
                                contents += "\n";
                                try {
                                    contents += cssConcat.concat( file );
                                } catch ( e ) {
                                    next( e.toString() );
                                }
                            });
                            contents = contents.trim();
                            applyFilter( baseUrl, filter, contents, ".css", next );
                        },
                        function ( contents, next ) {
                            fs.writeFile( baseOut, contents, 'utf8', next );
                        },
                        function( next ) {
                            try {
                                requirejs.optimize(
                                    {
                                        cssIn: baseOut,
                                        out: optimizedOut,
                                        optimizeCss: "standard"
                                    },
                                    function( response ) {
                                        fs.readFile( optimizedOut, "utf-8", next );
                                    }
                                );
                            } catch ( e ){
                                next( e.toString() );
                            }
                        },
                        function( contents, next ) {
                            applyFilter( baseUrl, filter, contents, ".min.css", next );
                        },
                        function ( contents, next ) {
                            fs.writeFile( optimizedOut, contents, 'utf8', next );
                        }
                    ], function( err ) {
                        if( err ) {
                            promise.reject( err );
                        } else {
                            console.log( "buildCSSBundle: resolving promise" );
                            promise.resolve( out );
                        }
                    });
                },
                function( err ) {
                    promise.reject( err );
                }
            );
        }
    });
    return promise;
}

var bjsid = 0;
function buildJSBundle( project, config, name, filter, optimize ) {
    var id = bjsid ++;
    console.log( "buildJSBundle["+id+"]()" );
    var promise = new Promise(),
        baseUrl = config.baseUrl,
        wsDir = project.getWorkspaceDirSync(),
        ext = ( optimize ? ".min" : "" ) + ".js",
        out = path.join( project.getCompiledDirSync(), name + ext );

    path.exists( out, function ( exists ) {
        if ( exists ) {
            console.log( "buildJSBundle: resolving promise" );
            promise.resolve( out );
        } else {
            async.waterfall([
                function( next ) {
                    console.log( "buildJSBundle["+id+"](): step 1" );
                    var outDir = path.dirname( config.out );
                    console.log( "mkdir '" + outDir + "'" );
                    fs.mkdir( outDir, function( err ) {
                        if ( err && err.code != "EEXIST" ) {
                            next( err );
                        } else {
                            next();
                        }
                    });
                },
                function( next ) {
                    console.log( "buildJSBundle["+id+"](): step 2" );
                    try {
                        requirejs.optimize(
                            _.extend({
                                out: out,
                                optimize: ( optimize ? "uglify" : "none" )
                            }, config ),
                            function( response ) {
                                next( null, response );
                            }
                        );
                    } catch ( e ){
                        next( e.toString() );
                    }
                },
                function( response, next ) {
                    console.log( "buildJSBundle["+id+"](): step 3" );
                    fs.readFile( out, 'utf8', next );
                },
                function ( contents, next ) {
                    console.log( "buildJSBundle["+id+"](): step 4" );
                    applyFilter( baseUrl, filter, contents, ext, next );
                },
                function( contents, next ) {
                    fs.writeFile( out, contents, 'utf8', next );
                }
            ], function( err ) {
                if( err ) {
                    promise.reject( err );
                } else {
                    console.log( "buildJSBundle: resolving promise" );
                    promise.resolve( out );
                }
            });
        }
    });
    return promise;
}

function buildZipBundle( project, name, config, digest, filter )  {
    console.log( "buildZipBundle()" );
    var promise = new Promise(),
        baseUrl = config.baseUrl,
        basename = path.basename( name, ".zip" ),
        out = path.join( project.getCompiledDirSync(), digest + ".zip" );

    path.exists( out, function ( exists ) {
        if ( exists ) {
            promise.resolve( out );
        } else {
            promiseUtils.all([
                buildCSSBundle( project, config, digest, filter ),
                buildCSSBundle( project, config, digest, filter, true ),
                buildJSBundle( project, config, digest, filter ),
                buildJSBundle( project, config, digest, filter, true )
            ]).then(
                function( results ) {
                    var archive = new zip();

                    async.series([
                        function( next ) {
                            archive.addFiles(
                                [ ".css", ".min.css", ".js", ".min.js" ]
                                    .map(
                                    function( ext ) {
                                        return { name: basename + ext, path: path.join( project.getCompiledDirSync(), digest + ext ) };
                                    }
                                ),
                                next
                            );
                        },
                        function( next ) {
                            fs.writeFile( out, archive.toBuffer(), next );
                        }
                    ], function( err ) {
                        if( err ) {
                            promise.reject( err );
                        } else {
                            promise.resolve( out );
                        }
                    });
                }
            )
        }
    });
    return promise;
}

app.get( '/v1/bundle/:owner/:repo/:ref/:name?', function ( req, res ) {
    var project = new Project( req.params.owner, req.params.repo, req.params.ref ),
        include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = Boolean( req.param( "optimize", false ) ).valueOf(),
        baseUrl = req.param( "baseUrl", "." ),
        pragmas = JSON.parse( req.param( "pragmas", "{}" ) ),
        pragmasOnSave = JSON.parse( req.param( "pragmasOnSave", "{}" ) ),
        name = req.params.name || ( req.params.repo + ".js" ),
        ext = (optimize !== "none" ? ".min" : "") + ( path.extname( name ) || ".js" ),
        mimetype = mime.lookup( ext ),
        filter = req.param( "filter" ),
        shasum = crypto.createHash( 'sha1' ),
        wsDir   = project.getWorkspaceDirSync(),
        dstDir, dstFile, digest, hash;

    // var baseUrlFilters[baseUrl] = require(path.join(baseUrl, 'somemagicnameOrpackage.jsonEntry.js'));
	var config = {
		baseUrl: path.join( wsDir, baseUrl ),
		include: include,
        exclude: exclude,
        pragmas: pragmas,
        pragmasOnSave: pragmasOnSave,
        skipModuleInsertion: req.param( "skipModuleInsertion", "false" ) === "true" ,
        preserveLicenseComments: req.param( "preserveLicenseComments", "true" ) === "true"
	};

    shasum.update( JSON.stringify( config ) );
    shasum.update( mimetype );
    if ( filter ) {
        shasum.update( filter );
    }

    if ( mimetype === "application/zip" ) {
        // For the zip file, the name needs to be part of the hash because it will determine the name of the files inside the zip file
        shasum.update( name );
    }

    digest = shasum.digest( 'hex' );
    if ( filter ) {
        // Setting the flag for later clean up
        filters[ project.getWorkspaceDirSync() ] = filters[ project.getWorkspaceDirSync() ] || {};
        filters[ project.getWorkspaceDirSync() ][ path.join( baseUrl, filter ) ] = true;
    }

    if ( mimetype === "application/zip" ) {
        hash = digest;
    } else {
        hash += ( optimize ? ".min" : "" );
    }

    function onBundleBuildError( error ) {
        res.header( "Access-Control-Allow-Origin", "*");
        res.send( error, 500 );
        delete bundlePromises[ digest ];
    }

    function buildBundle() {
        var hash = digest;
        if ( mimetype === "application/zip" ) {
            bundlePromises[ hash ] = buildZipBundle( project, name, config, digest, filter );
        } else if ( mimetype === "text/css" ) {
            bundlePromises[ hash  ] = buildCSSBundle( project, config, digest, filter, optimize );
        } else {
            bundlePromises[ hash ] = buildJSBundle( project, config, digest, filter, optimize );
        }
        bundlePromises[ hash ].then( onBundleBuilt, onBundleBuildError );
    }

    function onBundleBuilt( bundle ) {
        path.exists( bundle, function ( exists ) {
            if ( exists ) {
                res.header( "Access-Control-Allow-Origin", "*");
                res.download( bundle, name );
            } else {
                // Try to land back on our feet if for some reasons the built bundle got cleaned up;
                delete bundlePromises[ hash ];
                buildBundle();
            }
        });
    }

    if ( !bundlePromises[ hash ] ) {
        buildBundle();
    } else {
        bundlePromises[ hash ].then( onBundleBuilt, onBundleBuildError );
    }
});

app.get( '/v1/dependencies/:owner/:repo/:ref', function ( req, res ) {
    var project = new Project( req.params.owner, req.params.repo, req.params.ref ),
        names = req.param( "names", "" ).split( "," ).filter( function(name) {return !!name} ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        baseUrl = path.normalize( path.join( project.getWorkspaceDirSync(), req.param( "baseUrl", "." ) ) );

    buildDependencyMap( project, baseUrl, names )
        .then( function( content ) {
            res.header( "Access-Control-Allow-Origin", "*");
            res.json( content );
        }, function( err ) {
            res.send( err, 500 );
        });
});

console.log( "listening on port:", httpPort );
app.listen( httpPort );