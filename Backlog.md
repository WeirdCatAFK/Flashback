# To implement

* Decks

The capacity to make decks with existing flashcards with an interface that lets you add any flashcard from any document into a set and naming. This with it's capacity to be stored in the canonical datamodel (maybe a different adjacent storage on root? or instead of workspace so that if a user wants to edit the data manually it can just copy both directories workspace and decks? maybe on root of workspace with a reserved name?). So the deck creator would have a search bar that would return cards with their preview and you could add them with to the deck even if they are from other document, or you can make unlinked cards that exist on themselves (canonical model has to find a way to store both a collection of cards that reference another file and cards that don't reference any card, maybe changing the import so that they are written both on the root and the card with the same hash, giving priority to the document one to set )

* Renderer and editors afterthought

Even if at this point I want to limit all file editors to only have the capacity of highlighting (only text and markdown)

* Seal

Revisit the seal module logic and come up with a solution to the slowness on the transactions and the file change upkeeping cost on disk

* Make more expected behaviour tests
* Highlight import into the db
* Flashcard manager (one of the main features)

Given a space on the lateral tab I'd like it to have a master search feature that lets you search by filter, tags, documents, etc, etc, gives you the interface to make decks. and lets you see your cards by level. I'd like it to be conformed by a traditional  searchbox that returns a bunch or rows with the info on each card (obviosuly sort by feature) and another feature that let's you drag and drop flashcards to make decks with a more skeumorphic searchbox that returns flashcards as 

* Type answer flashcards actively break the loop of reviewing flashcards, it forces the user to click on the text input and may deter users that like the app for its high quality trainer
* Trainer may start a session
* When exiting the session tab to check a document or upon pressing see source, it should remember the state of the current study session
* Replace
