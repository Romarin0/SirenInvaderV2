module.exports = csv_to_table = (csv) => {
    let lines = csv.split("\n");
    let table = [];

    for (let i = 0; i < lines.length; ++i) {
        table.push(lines[i].split(','));
    }

    return table;
}