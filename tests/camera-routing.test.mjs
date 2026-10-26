import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraDestination,cameraImageMessages} from '../backend/camera-routing.mjs';
test('hotel uniform and guest clothes use the same group',()=>{
 assert.deepEqual(cameraDestination('然一制服'),{hotel:'然一',label:'然一制服'});
 assert.deepEqual(cameraDestination('然一客衣'),{hotel:'然一',label:'然一客衣'});
});
test('general garment group is separate',()=>{
 assert.deepEqual(cameraDestination('客衣'),{hotel:'客衣',label:'客衣'});
});
test('reject invalid QR codes',()=>{
 assert.equal(cameraDestination(''),null);
 assert.equal(cameraDestination('https://example.com'),null);
});
test('LINE images require HTTPS',()=>{
 assert.throws(()=>cameraImageMessages('http://localhost/photo.jpg','然一'),/HTTPS/);
 assert.equal(cameraImageMessages('https://example.com/photo.jpg','然一制服')[1].type,'image');
});
