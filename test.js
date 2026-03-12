var data = null

function getUser(id) {
  var result = data[id]  // bug: data is null, this will crash
  return result
}

function addNumbers(a, b) {
  var sum = a + b
  var unused = "nobody uses me"  // bug: unused variable
  return sum
}