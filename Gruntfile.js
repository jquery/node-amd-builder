module.exports = function( grunt ) {
	"use strict";

	// Project configuration.
	grunt.initConfig( {
		jshint: {
			all: [
				"Gruntfile.js",
				"lib/*.js",
				"server.js"
			],
			options: {
				jshintrc: ".jshintrc"
			}
		},

		"release-it": {
			options: {
				pkgFiles: [ "package.json" ],
				commitMessage: "Release %s",
				tagName: "v%s",
				tagAnnotation: "Release %s",
				buildCommand: false
			}
		}
	});

	require( "load-grunt-tasks" )( grunt );

	// By default, lint and run all tests.
	grunt.registerTask( "default", [ "jshint" ] );
};
