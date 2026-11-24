"use strict";
const {getDb}=require("../db/sqlite");
function db(){
 const d=getDb();
 d.exec("CREATE TABLE IF NOT EXISTS concert_countdowns (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, config TEXT NOT NULL, photo BLOB, photo_type TEXT, message_id TEXT, enabled INTEGER NOT NULL DEFAULT 0, fingerprint TEXT, last_success TEXT, last_error TEXT, PRIMARY KEY(guild_id,channel_id))");
 return d;
}
const get=(g,c)=>db().prepare("SELECT * FROM concert_countdowns WHERE guild_id=? AND channel_id=?").get(g,c);
const list=g=>db().prepare("SELECT * FROM concert_countdowns WHERE guild_id=?").all(g);
const enabled=()=>db().prepare("SELECT * FROM concert_countdowns WHERE enabled=1").all();
function save(g,c,config){db().prepare("INSERT INTO concert_countdowns(guild_id,channel_id,config) VALUES(?,?,?) ON CONFLICT(guild_id,channel_id) DO UPDATE SET config=excluded.config,fingerprint=NULL").run(g,c,JSON.stringify(config));}
function photo(g,c,bytes,type){db().prepare("UPDATE concert_countdowns SET photo=?,photo_type=?,fingerprint=NULL WHERE guild_id=? AND channel_id=?").run(bytes,type,g,c);}
function update(g,c,fields){const allowed=["message_id","enabled","fingerprint","last_success","last_error"];const keys=Object.keys(fields);if(!keys.length||keys.some(k=>!allowed.includes(k)))throw Error("Invalid update");db().prepare("UPDATE concert_countdowns SET "+keys.map(k=>k+"=?").join(",")+" WHERE guild_id=? AND channel_id=?").run(...keys.map(k=>fields[k]),g,c);}
module.exports={get,list,enabled,save,photo,update};
