/**
 * @fileoverview Rule to flag for-in loops without if statements inside
 * @author Nicholas C. Zakas
 */

"use strict";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = function(context) {

    return {

        "ForInStatement": function(node) {
          context.report(node, "You should not use a for-in statement");
        }

    };

};

module.exports.schema = [];
