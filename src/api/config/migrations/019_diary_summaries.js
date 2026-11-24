export const version = 19;
export const description = 'DiarySummaries: a cache of daily summaries, derived from the review log';

export async function up(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS main.DiarySummaries (
        scope VARCHAR(100) NOT NULL,
        date VARCHAR(10) NOT NULL,
        summary TEXT NOT NULL,
        PRIMARY KEY (scope, date)
    )`);
}
