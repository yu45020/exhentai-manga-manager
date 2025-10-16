# Searcher

Boolean search with a fuzzy suggestion dropdown list. The default search checks title, title jpn, file name, and all tags. The suggestion is based on the query string.

* Basic query pattern `updateScope:term`: find `term` in `updateScope`.

* Advanced query pattern
    * `updateScope:term1 term2`: `updateScope:term1` and `term2`
    * `updateScope:term1 -term2`: `updateScope:term1` and NOT `term2`
    * `updateScope:term1 (term2 | term3)`: `updateScope:term1` and (`term2` OR `term3`)

* Supported boolean operators: `AND (+)`, `OR (|)`, `NOT (-)` `( )`

* Fuzzy suggestion:
    * `=` , `^`, `!`, `^`, etc
    * extended syntax supported by [`fuse.js`](https://www.fusejs.io/examples.html#extended-search)

* Search:
    * `>`, `<`, `>=`, `<=` `=`,   `*`
    * syntax supported by [`liqe`](https://github.com/gajus/liqe)

* Special terms:
    * filter books by datetime:  [apm]time:> YYYY-MM-DD, or YYYY-MM, or YYYY
    * find books by page difference: `pagediff`

* Additional examples
    * a AND b, a + b:  search for a AND b
    * a - b:  search for a AND NOT b
    * a OR b, a~b:  search for a OR b
    * "a b" :  search for "a b"
    * a b - c :  search for (a AND b) AND NOT c

## Usage

The search is initialized in `App.vue`. `makeFuseSearch.suggest` gives the suggestion list, and `makeFuseSearch.execQuery` executes the search, and `makeFuseSearch.updateIndex` updates indexes. We don't copy the bookList internally.

## Internal Designs

### Suggestion

The searcher uses `fuse.js` to build multiple indexes for fuzzy suggestions. One for all titles, one for all unique tag values, one for book category, one for book status, and one for each tag subcategory.

The pop-up list thus depends on the library metadata. For example, if `blue archive` is in the group tag, then typing `blue` will pop up `blue archive` in the suggestion list.

The default suggestion is on all tags and all titles. Adding a updateScope will limit the suggestion to that updateScope. For example, `parody:b` will only suggest parodies that start with `b`.

When the user clicks a suggestion, the search will execute the query and filter books. The user can further refine the search, and the suggestion will be based on the additional query only. For example, in a query  `parody:"blue archive" a:b`, the suggestion will be lists artist names that start with `b`.

We choose `fuse.js` as it has relatively good performance and easy to use. It provides configurations on filtering scores, and it is also used to fuzzy match book metadata by file names.

## Search

A query is first parsed internally into a string of updateScope and terms for the `liqe` library. The scopy is then mapped to `bookList` keys. `liqe` then filter the current `bookList` based on the query.

  