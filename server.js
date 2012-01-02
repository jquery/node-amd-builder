'use strict';

var express = require( 'express'),
    app = express.createServer(),
    crypto = require( 'crypto' ),
    fs = require( 'fs' ),
    exec = require( 'child_process' ).exec,
    path = require( 'path' ),
    querystring = require( 'querystring' ),
    regexp = require( './lib/regexp' ),
    requirejs = require( './lib/r.js' );

var httpPort = process.env.PORT || 8080,
    repoBaseDir = process.env.REPO_BASE_DIR,
    workBaseDir = process.env.WORK_BASE_DIR;

app.configure('development', function(){
    app.use( express.errorHandler({ dumpExceptions: true, showStack: true }) );
});

app.configure('production', function(){
});

app.use(express.bodyParser());

app.get( '/', function ( req, res ) {
    res.send( "<h1 style='text-align: center; font-size: 120px;'>ZOMG JQM-BUILDER</h1>" );
});

app.get( '/:repo/fetch', function ( req, res ) {
    exec( "git fetch",
        {
            encoding:'utf8',
            timeout:0,
            cwd: bareRepo,
            env:null
        },
        function ( error, stdout, stderr ) {
            //console.log('stdout: ' + stdout);
            //console.log('stderr: ' + stderr);
            if ( error !== null ) {
                res.send( error, 500 );
            } else {
                res.send( stdout );
            }
        }
    );
});

app.post( '/post_receive', function ( req, res ) {
    var payload = req.body.payload;

    if ( payload ) {
        try {
            payload = JSON.parse( payload );

            if ( payload.repository && payload.repository.name ) {
                var repoDir = repoBaseDir + payload.repository.name + ".git";
                path.exists( repoDir , function( exists ) {
                    if ( exists ) {
                        exec( "git fetch",
                            {
                                encoding:'utf8',
                                timeout:0,
                                cwd: repoDir,
                                env:null
                            },
                            function ( error, stdout, stderr ) {
                                if ( error !== null ) {
                                    res.send( error, 500 );
                                } else {
                                    res.send( stdout );
                                }
                            }
                        );
                    } else {
                        res( "Wrong door!", 404 );
                    }
                });
            } else {
                res( "Wrong door!", 404 );
            }
        } catch( e ) {
            res.send( e, 500 );
        }
    } else {
        res.send( "No Payload!", 400 );
    }
});

app.get( '/:repo/:tag/checkout', function ( req, res ) {
    var wsDir   = workBaseDir + "/" + req.params.repo + "." + req.params.tag;

    fs.mkdir( dstDir, function () {
        exec( "git --work-tree=" + wsDir + " checkout -f " + req.params.tag,
            {
                encoding: 'utf8',
                timeout: 0,
                cwd: wsDir,
                env: null
            },
            function ( error, stdout, stderr ) {
                console.log( 'stdout: ' + stdout );
                console.log( 'stderr: ' + stderr );
                if ( error !== null ) {
                    res.send( error, 500 );
                } else {
                    res.send( stdout );
                }
            }
        );
    });
});

app.get( '/:repo/:tag/make', function ( req, res ) {
    var include = req.param( "include", "main" ).split( "," ).sort(),
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        optimize = req.param( "optimize", "none" ),
        baseUrl = req.param( "baseUrl", "." ),
        hasPragmas = !!req.param( "pragmas", false ),
        pragmas = hasPragmas?querystring.stringify( JSON.parse( req.param( "pragmas" ) ), ",", "=" ).split( "," ).map( function(val) { return "pragmas." + val; } ):[],
        hasPragmasOnSave = !!req.param( "pragmasOnSave", false ),
        pragmasOnSave = hasPragmasOnSave?querystring.stringify( JSON.parse( req.param( "pragmasOnSave" ) ), ",", "=" ).split( "," ).map( function(val) { return "pragmasOnSave." + val; } ):[],
        name = path.basename( req.param( "name", req.params.repo ), ".js" ),
        wsDir   = workBaseDir + "/" + req.params.repo + "." + req.params.tag,
        dstDir  = wsDir + "/compiled/" + include.join( "+" ),
        dstFile = dstDir + "/" + name + (optimize !== "none" ? ".min" : "") + ".js";

    path.exists( dstFile, function ( exists ) {
        if ( exists ) {
            res.download( dstFile, path.basename( dstFile ) );
        } else {
            exec( [ process.execPath,
                __dirname + '/node_modules/.bin/r.js',
                '-o',
                'baseUrl=' + baseUrl,
                'include=' + include.join( "," ),
                exclude?'exclude=' + exclude.join( "," ):"",
                'out=' + dstFile,
                'optimize=' + optimize ]
                .concat( pragmas )
                .concat( pragmasOnSave )
                .join( " " ),
                {
                    encoding:'utf8',
                    timeout:0,
                    cwd: wsDir,
                    env:null
                },
                function ( error, stdout, stderr ) {
                    console.log( 'stdout: ' + stdout );
                    console.log( 'stderr: ' + stderr );
                    if ( error !== null ) {
                        res.send( error, 500 );
                    } else {
                        res.download( dstFile, path.basename( dstFile ) );
                    }
                }
            );
        }
    });
});

app.get( '/:repo/:tag/dependencies', function ( req, res ) {
    var wsDir   = workBaseDir + "/" + req.params.repo + "." + req.params.tag,
        exclude = req.param( "exclude", "" ).split( "," ).sort(),
        names = req.param( "names", req.params.repo ).split( "," ).sort(),
        baseUrl = path.normalize( wsDir + "/" + req.param( "baseUrl", "." ) ),
        shasum = crypto.createHash( 'sha1' ),
        filename = wsDir + "/deps-";

    // Generate a sha on the sorted names
    shasum.update( names.join( "," ) );
    filename += shasum.digest( 'hex' ) + ".json";

    path.exists( filename, function( exists ) {
        if ( exists ){
            res.sendfile( filename );
        } else {
            requirejs.tools.traceFiles( {
                    baseUrl: baseUrl,
                    modules: names.map( function( name ) { return { name: name } } )
                },
                function( deps ) {
                    // Walk through the dep map and remove baseUrl and js extention
                    var module,
                        baseUrlRE = new RegExp( "^" + regexp.escapeString( baseUrl + "/") ),
                        jsExtRE = new RegExp( regexp.escapeString( ".js" ) + "$" );
                    for ( module in deps ) {
                        deps[ module ].files.pop();
                        deps[ module ].deps = deps[ module ].files.map(
                            function( file ) {
                                return file.replace( baseUrlRE, "" ).replace( jsExtRE, "" );
                            }
                        );
                        delete deps[ module ].files;
                    }
                    fs.writeFile( filename, JSON.stringify( deps ),
                        function (err) {
                            if (err) throw err;
                        }
                    );
                    res.json( deps );
                }
            );
        }
    });
});

console.log( "listening on port:", httpPort );
app.listen( httpPort );