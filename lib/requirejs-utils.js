var requirejs = require( "requirejs" );

function redefineRequireJSLogging( print ) {
	// Redefine the logging function for r.js
	requirejs.define( 'node/print', function() {
		if ( !print ) {
			print = console.log;
		}

		return print;
	});
}

exports.redefineRequireJSLogging = redefineRequireJSLogging;
