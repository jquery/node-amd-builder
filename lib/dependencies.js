"use strict";

var async = require( "async" ),
	crypto = require( 'crypto' ),
	fs = require( "fs" ),
	glob = require("glob" ),
	path = require( 'path' ),
	Promise = require( "node-promise" ).Promise,
	regexp = require( './regexp' ),
	requirejs = require( 'requirejs' ),
	redefineRequireJSLogging = require( "./requirejs-utils" ).redefineRequireJSLogging;

var log,
//	bid = 0,
	dependenciesPromises = {};

function getFiles( dir, pattern, mapFn, callback ) {
	async.waterfall([
		function( next ) {
			glob( pattern, { cwd: dir }, next );
		},
		function( matches, next ) {
			next( null, matches.map( mapFn ) );
		}
	], callback);
}

function buildMap( workspaceDir, baseUrl, compiledDir, include ) {
//	var id = bid++;
//	logger.log( "buildMap["+id+"]()" );
	var promise = new Promise(),
		shasum = crypto.createHash( 'sha1' ),
		filename = "";

	// Setting baseUrl to absolute
	baseUrl = path.normalize( path.join( workspaceDir, baseUrl ) );

	async.waterfall([
		function( next ) {
			// logger.log( "buildMap["+id+"](): step 1" );
			// If no name is provided, scan the baseUrl for js files and return the dep map for all JS objects in baseUrl
			if ( include && include.length > 0 ) {
				next( null, null );
			} else {
				getFiles(
					baseUrl,
					"**/*.js",
					function( file ) {
						return file.replace( /\.js$/, "" );
					},
					next
				);
			}
		},
		function( results, next ) {
			if ( !( include && include.length > 0 ) ) {
				include = results;
			}
			// logger.log( "buildMap["+id+"](): step 2" );
			// Generate a sha on the sorted names
			var digest = shasum.update( include.join( "," ) ).digest( "hex" );

			filename += path.join( compiledDir, "deps-" + digest + ".json" );

			fs.exists( filename, function( exists ) {
				next( null, digest, exists );
			});
		},
		function( digest, exists, next ) {
			// logger.log( "buildMap["+id+"](): step 3" );
			if ( exists ) {
				fs.readFile( filename, "utf8", function( err, data ) {
					if ( err ) {
						next( err );
					} else {
						next( err, JSON.parse( data ) );
					}
				});
			} else {
				if ( !dependenciesPromises[ digest ]) {
					dependenciesPromises[ digest ] = promise;
					async.waterfall([
						function( cb ) {
							// logger.log( "buildMap["+id+"](): step 3.1" );
							fs.mkdir( compiledDir, function( err ) {
								if ( err && err.code !== "EEXIST" ) {
									cb( err );
								} else {
									cb();
								}
							});
						},
						function( cb ) {
							// logger.log( "buildMap["+id+"](): step 3.2" );
							redefineRequireJSLogging( log );

							requirejs.tools.useLib( function( r ) {
								r([ 'parse' ], function( parse ) {
									cb( null, parse );
								});
							});
						},
						function( parse, cb ) {
							// logger.log( "buildMap["+id+"](): step 3.3" );
							var deps = {};
							async.forEach( include, function( name, done ) {
								var fileName = path.join( baseUrl, name + ".js" ),
									dirName = path.dirname( fileName );
								console.log( "Processing: " + fileName );
								fs.readFile( fileName, "utf8", function( err, data ) {
									if ( err ) {
										console.error( err );
										done( err );
									} else {
										deps[ name ] = {};
										try{
											deps[ name ].deps = parse.findDependencies( fileName, data ).map(
												function( module ) {
													// resolve relative paths
													return path.relative( baseUrl, path.resolve( dirName, module ) );
												}
											);
											done();
										} catch( e ) {
											done( e.message );
										}
									}
								});
							}, function( err ) {
								cb( err, deps );
							});
						},
						function( deps, cb ) {
							// logger.log( "buildMap["+id+"](): step 3.4" );
							// Walk through the dep map and remove baseUrl and js extension
							var module,
								modules = [];

							for ( module in deps ) {
								modules.push( module );
							}

							async.forEach( modules,
								function( item, callback ) {
									async.waterfall([
										function( next ) {
											// logger.log( "buildMap["+id+"](): step 3.4.1" );
											fs.readFile( path.join( baseUrl, item + ".js" ), 'utf8', next );
										},
										function( data, next ) {
											// logger.log( "buildMap["+id+"](): step 3.4.2" );
											var lines = data.split( "\n" ),
												matches = lines.filter( function( line ) {
													return /^.*\/\/>>\s*[^:]+:.*$/.test( line );
												});
											if ( matches && matches.length ) {
												matches.forEach( function( meta ) {
													var attr = meta.replace( /^.*\/\/>>\s*([^:]+):.*$/, "$1" ).trim(),
														attrLabelRE = new RegExp( "^.*" + regexp.escapeString( "//>>" + attr + ":" ) + "\\s*", "m" ),
														value = meta.replace( attrLabelRE, "" ).trim(),
														namespace, name,
														indexOfDot = attr.indexOf( "." );
													if ( indexOfDot > 0 ) { // if there is something before the dot
														namespace = attr.split( "." )[0];
														name = attr.substring( indexOfDot + 1 );
														deps[ item ][ namespace ] = deps[ item ][ namespace ] || {};
														deps[ item ][ namespace ][ name ] = value;
													} else {
														deps[ item ][ attr ] = value;
													}
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
							);
						},
						function( deps, cb ) {
							// logger.log( "buildMap["+id+"](): step 3.5" );
							fs.writeFile( filename, JSON.stringify( deps ), "utf8",
								function( err ) {
									cb( err, deps );
								}
							);
						}
					], next );
				} else {
					dependenciesPromises[ digest ].then(
						function( data ) {
							next( null, data );
						},
						next
					);
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

function reset() {
	dependenciesPromises = {};
}

function setLogFunction( logFn ) {
	log = logFn;
}

exports.setLogFunction = setLogFunction;
exports.reset = reset;
exports.buildMap = buildMap;
