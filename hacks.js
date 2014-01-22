
console.log(test());

var speak_english = true;
if ( speak_english ) {
  function test() {return "Hello World!";}
} else {
  function test() {return "Hej Verden!";}
}

console.log(test());
