// 根书签(id=0)
// 书签栏(id=1)
// 其他书签(id=2)
let tree = chrome.bookmarks.getTree('0').then(function(data) {
    console.log(JSON.stringify(data));
});
