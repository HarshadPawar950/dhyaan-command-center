// =============================================================
// lib/safeDbError.js — turn a raw DB/Node error into a USER-SAFE message.
//
// Raw err.message from Postgres leaks internals (column names, types,
// constraint names, the offending value). NEVER put err.message into a
// flash / response shown to a user. Log the real error server-side
// (console.error(err)) and show the string returned here instead.
//
// Keyed off the Postgres SQLSTATE `err.code` so the user still gets a
// helpful hint ("a number is too large") without exposing schema.
// Unknown codes fall through to a generic, safe fallback.
// =============================================================

// SQLSTATE → friendly, non-leaking message.
const MESSAGES = {
    '22003': 'One of the numbers you entered is too large or too small. Please check the numeric fields and try again.', // numeric_value_out_of_range
    '22P02': 'One of the fields has an invalid value. Please check your entries and try again.',                          // invalid_text_representation
    '22001': 'One of the text fields is too long. Please shorten it and try again.',                                      // string_data_right_truncation
    '23502': 'A required field was left blank. Please fill it in and try again.',                                         // not_null_violation
    '23503': 'This references a record that no longer exists. Please refresh and try again.',                             // foreign_key_violation
    '23505': 'A record like this already exists.',                                                                        // unique_violation
    '23514': 'One of the values is outside the allowed range. Please check your entries.',                               // check_violation
};

// userSafeError(err, fallback?) -> string safe to show a user.
// `fallback` lets the caller phrase a context-specific generic
// ("Could not save the booking. Please try again.").
function userSafeError(err, fallback) {
    const code = err && err.code;
    if (code && MESSAGES[code]) return MESSAGES[code];
    return fallback || 'Something went wrong. Please check your input and try again.';
}

module.exports = { userSafeError };
