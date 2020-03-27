const {
  align,
  breakParent,
  concat,
  hardline,
  group,
  ifBreak,
  indent,
  softline
} = require("../prettier");
const { containsAssignment, isEmptyStmts } = require("../utils");

const printWithAddition = (keyword, path, print, { breaking = false } = {}) =>
  concat([
    `${keyword} `,
    align(keyword.length + 1, path.call(print, "body", 0)),
    indent(concat([softline, path.call(print, "body", 1)])),
    concat([softline, path.call(print, "body", 2)]),
    concat([softline, "end"]),
    breaking ? breakParent : ""
  ]);

// For the unary `not` operator, we need to explicitly add parentheses to it in
// order for it to be valid from within a ternary. Otherwise if the clause of
// the ternary isn't a unary `not`, we can just pass it along.
const printTernaryClause = (clause) => {
  if (clause.type === "concat") {
    const [part] = clause.parts;

    if (part.type === "concat" && part.parts[0] === "not") {
      // We are inside of a statements list and the statement is a unary `not`.
      return concat(["not(", part.parts[2], ")"]);
    }

    if (clause.parts[0] === "not") {
      // We are inside a ternary condition and the clause is a unary `not`.
      return concat(["not(", clause.parts[2], ")"]);
    }
  }

  return clause;
};

// The conditions for a ternary look like `foo : bar` where `foo` represents
// the truthy clause and `bar` represents the falsy clause. In the case that the
// parent node is an `unless`, these have to flip in order.
const printTernaryClauses = (keyword, truthyClause, falsyClause) => {
  const parts = [
    printTernaryClause(truthyClause),
    " : ",
    printTernaryClause(falsyClause)
  ];

  return keyword === "if" ? parts : parts.reverse();
};

// Handles ternary nodes. If it does not fit on one line, then we break out into
// an if/else statement. Otherwise we remain as a ternary.
const printTernary = (path, _opts, print) => {
  const [predicate, truthyClause, falsyClause] = path.map(print, "body");
  const ternaryClauses = printTernaryClauses("if", truthyClause, falsyClause);

  return group(
    ifBreak(
      concat([
        "if ",
        align(3, predicate),
        indent(concat([softline, truthyClause])),
        concat([softline, "else"]),
        indent(concat([softline, falsyClause])),
        concat([softline, "end"])
      ]),
      concat([predicate, " ? "].concat(ternaryClauses))
    )
  );
};

// Prints an `if_mod` or `unless_mod` node. Because it was previously in the
// modifier form, we're guaranteed to not have an additional node, so we can
// just work with the predicate and the body.
const printSingle = (keyword) => (path, { inlineConditionals }, print) => {
  const [_predicate, statements] = path.getValue().body;
  const printedPredicate = path.call(print, "body", 0);
  const printedStatements = path.call(print, "body", 1);

  const multilineParts = [
    `${keyword} `,
    align(keyword.length + 1, printedPredicate),
    indent(concat([softline, printedStatements])),
    concat([softline, "end"])
  ];

  // If the body of the conditional is empty but it has comments, then we don't
  // want to print a newline before we print the comments, because it will
  // result in an extra line in the body.
  if (isEmptyStmts(statements) && statements.comments) {
    multilineParts[2] = indent(printedStatements);
  }

  // If we do not allow modifier form conditionals or there are comments inside
  // of the body of the conditional, then we must print in the multiline form.
  if (!inlineConditionals || statements.comments) {
    return concat(multilineParts);
  }

  let inlineParts = [printedStatements, ` ${keyword} `, printedPredicate];

  // If the return value of this conditional expression is being assigned to
  // anything besides a local variable then we can't inline the entire
  // expression without wrapping it in parentheses. This is because the
  // following expressions have different semantic meaning:
  //
  //     hash[:key] = :value if false
  //     hash[:key] = if false then :value end
  //
  // The first one will not result in an empty hash, whereas the second one
  // will result in `{ key: nil }`. In this case what we need to do for the
  // first expression to align is wrap it in parens, as in:
  //
  //     hash[:key] = (:value if false)
  if (["assign", "massign"].includes(path.getParentNode().type)) {
    inlineParts = ["("].concat(inlineParts).concat(")");
  }

  return group(ifBreak(concat(multilineParts), concat(inlineParts)));
};

const noTernary = [
  "@comment",
  "alias",
  "assign",
  "break",
  "command",
  "command_call",
  "if_mod",
  "ifop",
  "lambda",
  "massign",
  "next",
  "opassign",
  "rescue_mod",
  "return",
  "return0",
  "super",
  "undef",
  "unless_mod",
  "until_mod",
  "var_alias",
  "void_stmt",
  "while_mod",
  "yield",
  "yield0",
  "zsuper"
];

// Certain expressions cannot be reduced to a ternary without adding parens
// around them. In this case we say they cannot be ternaried and default instead
// to breaking them into multiple lines.
const canTernaryStmts = (stmts) => {
  if (stmts.body.length !== 1) {
    return false;
  }

  const stmt = stmts.body[0];

  // If the user is using one of the lower precedence "and" or "or" operators,
  // then we can't use a ternary expression as it would break the flow control.
  if (stmt.type === "binary" && ["and", "or"].includes(stmt.body[1])) {
    return false;
  }

  // Check against the blocklist of statement types that are not allowed to be
  // a part of a ternary expression.
  return !noTernary.includes(stmt.type);
};

// In order for an `if` or `unless` expression to be shortened to a ternary,
// there has to be one and only one "addition" (another clause attached) which
// is of the "else" type. Both the body of the main node and the body of the
// additional node must have only one statement, and that statement list must
// pass the `canTernaryStmts` check.
const canTernary = (path) => {
  const [_pred, stmts, addition] = path.getValue().body;

  return (
    addition &&
    addition.type === "else" &&
    [stmts, addition.body[0]].every(canTernaryStmts)
  );
};

// A normalized print function for both `if` and `unless` nodes.
const printConditional = (keyword) => (path, { inlineConditionals }, print) => {
  if (canTernary(path)) {
    let ternaryParts = [path.call(print, "body", 0), " ? "].concat(
      printTernaryClauses(
        keyword,
        path.call(print, "body", 1),
        path.call(print, "body", 2, "body", 0)
      )
    );

    if (["binary", "call"].includes(path.getParentNode().type)) {
      ternaryParts = ["("].concat(ternaryParts).concat(")");
    }

    return group(
      ifBreak(printWithAddition(keyword, path, print), concat(ternaryParts))
    );
  }

  const [predicate, stmts, addition] = path.getValue().body;

  // If there's an additional clause that wasn't matched earlier, we know we
  // can't go for the inline option.
  if (addition) {
    return group(printWithAddition(keyword, path, print, { breaking: true }));
  }

  // If the body of the conditional is empty, then we explicitly have to use the
  // block form.
  if (isEmptyStmts(stmts) && !stmts.comments) {
    return concat([
      `${keyword} `,
      align(keyword.length + 1, path.call(print, "body", 0)),
      concat([hardline, "end"])
    ]);
  }

  // If the predicate of the conditional contains an assignment, then we can't
  // know for sure that it doesn't impact the body of the conditional, so we
  // have to default to the block form.
  if (containsAssignment(predicate)) {
    return concat([
      `${keyword} `,
      align(keyword.length + 1, path.call(print, "body", 0)),
      indent(concat([hardline, path.call(print, "body", 1)])),
      concat([hardline, "end"])
    ]);
  }

  return printSingle(keyword)(path, { inlineConditionals }, print);
};

module.exports = {
  else: (path, opts, print) => {
    const stmts = path.getValue().body[0];

    return concat([
      stmts.body.length === 1 && stmts.body[0].type === "command"
        ? breakParent
        : "",
      "else",
      indent(concat([softline, path.call(print, "body", 0)]))
    ]);
  },
  elsif: (path, opts, print) => {
    const [_predicate, _statements, addition] = path.getValue().body;
    const parts = [
      group(
        concat([
          "elsif ",
          align("elsif".length - 1, path.call(print, "body", 0))
        ])
      ),
      indent(concat([hardline, path.call(print, "body", 1)]))
    ];

    if (addition) {
      parts.push(group(concat([hardline, path.call(print, "body", 2)])));
    }

    return group(concat(parts));
  },
  if: printConditional("if"),
  ifop: printTernary,
  if_mod: printSingle("if"),
  unless: printConditional("unless"),
  unless_mod: printSingle("unless")
};
