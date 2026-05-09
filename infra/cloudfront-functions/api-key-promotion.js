function handler(event) {
  var request = event.request
  var params = request.querystring

  // Only promote if x-api-key header not already present
  if (!request.headers['x-api-key'] && params['ApiKey']) {
    request.headers['x-api-key'] = {value: params['ApiKey'].value}
    console.log('Promoted ApiKey from querystring to x-api-key header')
  }

  return request
}
