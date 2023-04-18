//todo external api store
//1. get specific service with authentication methods
//2. get all services with authentication methods

//todo external api authentication service
//1. get all API connections for an organization, across all APIs
//2. get all API connections for an organization, for a specific API
//3. get credentials for the given service and id,
//  a) can return that there isn't a credential
//  b) can return that a credential has expired, in which case 3) is needed
//2. create new credential
//3. refresh an oauth2 credential

//todo oauth2 flow
//1. Build the UI
//  a) scope selection
//  b) trigger the flow
//  c) handle the returned data and errors
//2. Server side
//  a) store the credentials
//  b) refresh the credentials when needed

//todo secret storage
//1. store lookup info, org, any metadata and the security provider, e.g. "insecure", "aws_param_store"
//2. implement the insecure provider
//   - local JSON file that is git ignored, throw warnings if the NODE_ENV is production and not work
//3. implement the aws_param_store provider
