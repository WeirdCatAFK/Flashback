import db from '../../primitives/database.js';
import { CARD_LEARNED_SQL, PROGRESS_JOIN, scoped } from './sql.js';

export async function getData(scope) {
    const account = scoped(scope);
    const nodes = await db.prepare(`
        WITH RECURSIVE folder_tree AS (
            SELECT id, id AS root_id FROM Folders
            UNION ALL
            SELECT fo.id, ft.root_id FROM Folders fo
            JOIN folder_tree ft ON fo.parent_id = ft.id
        ),
        -- Recursive card rollup per folder: every card in the folder's whole
        -- subtree, counted and summed. Folders.presence can't stand in for this
        -- — it's an unweighted average of document presences, so it says how
        -- well the folder is known but nothing about how much it holds.
        -- Seeded from every folder, so this is O(folders x depth); at vault
        -- scale that's cheaper than a query per folder.
        folder_rollup AS (
            SELECT ft.root_id,
                   COUNT(ffc.id)                                 AS cardCount,
                   COALESCE(SUM(${CARD_LEARNED_SQL('ffp')}), 0)  AS learnedSum
            FROM folder_tree ft
            JOIN Documents fd ON fd.folder_id = ft.id
            LEFT JOIN Flashcards ffc ON ffc.document_id = fd.id
            ${PROGRESS_JOIN('ffc', 'ffp')}
            GROUP BY ft.root_id
        )
        SELECT n.id, nt.name as type,
               COALESCE(d.name, f.name, t.name, fc.name, dk.name) as label,
               COALESCE(d.presence, f.presence, fc.presence, 0) as presence,
               d.relative_path  as documentPath,
               fc.global_hash   as flashcardHash,
               fcc.frontText    as flashcardFront,
               fcd.relative_path as flashcardDocPath,
               dk.is_system      as deckIsSystem,
               dl.cardCount      as cardCount,
               dl.learnedSum     as learnedSum,
               fr.cardCount      as folderCardCount,
               fr.learnedSum     as folderLearnedSum,
               ${CARD_LEARNED_SQL('fcp')} as flashcardLearned
        FROM Nodes n
        JOIN NodeTypes nt ON n.type_id = nt.id
        LEFT JOIN Documents d   ON d.node_id   = n.id
        LEFT JOIN Folders f     ON f.node_id   = n.id
        LEFT JOIN Tags t        ON t.node_id   = n.id
        LEFT JOIN Flashcards fc ON fc.node_id  = n.id
        ${PROGRESS_JOIN('fc', 'fcp')}
        LEFT JOIN FlashcardContent fcc ON fcc.id = fc.content_id
        LEFT JOIN Documents fcd        ON fcd.id = fc.document_id
        LEFT JOIN Decks dk ON dk.node_id = n.id
        LEFT JOIN (
            SELECT dfc.document_id,
                   COUNT(*)                        as cardCount,
                   SUM(${CARD_LEARNED_SQL('dfp')}) as learnedSum
            FROM Flashcards dfc
            ${PROGRESS_JOIN('dfc', 'dfp')}
            WHERE dfc.document_id IS NOT NULL
            GROUP BY dfc.document_id
        ) dl ON dl.document_id = d.id
        LEFT JOIN folder_rollup fr ON fr.root_id = f.id
        WHERE NOT (
            nt.name = 'Deck' AND NOT EXISTS (
                SELECT 1 FROM Connections c2
                JOIN ConnectionTypes ct2 ON c2.type_id = ct2.id
                WHERE c2.origin_id = n.id AND ct2.name = 'deck'
            )
        )
    `).all(account, account, account);

    const edges = await db.prepare(`
        SELECT source.id as fromId, target.id as toId, ct.name as relation
        FROM Connections c
        JOIN Nodes source ON c.origin_id = source.id
        JOIN Nodes target ON c.destiny_id = target.id
        JOIN ConnectionTypes ct ON c.type_id = ct.id

        UNION ALL

        SELECT fc.node_id as fromId, d.node_id as toId, 'reference' as relation
        FROM Flashcards fc
        JOIN Documents d ON fc.document_id = d.id

        UNION ALL

        SELECT c.destiny_id as fromId, tg.node_id as toId, 'tag' as relation
        FROM InheritedTags it
        JOIN Connections c ON it.connection_id = c.id
        JOIN Tags tg ON tg.id = it.tag_id
    `).all();

    return { nodes, edges };
}
