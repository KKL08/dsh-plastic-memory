export class InMemoryKvTable {
    map = new Map();
    get(key) { return this.map.get(key); }
    async put(key, value) { this.map.set(key, value); }
    async delete(key) { return this.map.delete(key); }
    entries() { return this.map.entries(); }
}
