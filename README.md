# Node AMD builder

This project aims at providing a NodeJS service to build bundles out of AMD projects in a git repository. This was developed to help jQuery Mobile build the bundle builder.
Initial checkout as well as workspace creation have to be done manually.

## API

### /{repo}/fetch

Fetch the latest version of the repo from the default remote.

### /{repo}/{ref}/checkout
Force checkout the ref into the {repo}.{ref} workspace if it exists.

### /{repo}/{ref}/dependencies
Traces 1st level dependencies.

URL arguments are:

 - ```baseUrl```: The baseUrl for module name to file resolution
 - ```names```: A comma separated list of modules to include in the dependency map

### /{repo}/{ref}/make

Builds a bundle for this repository's ref

URL arguments are:

 - ```baseUrl```: The baseUrl for module name to file resolution
 - ```include```: A comma separated list of modules to include in the bundle
 - ```exclude```: A comma separated list of modules to exclude from the bundle
 - ```optimize```: "none" or "uglify"
