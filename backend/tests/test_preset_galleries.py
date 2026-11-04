"""Gallery lookup keeps composite source identity and exposes explicit cache coverage."""
from test_api import client


def test_gallery_lookup_uses_kind_collection_and_item(client):
    catalogue = client.get('/api/material-presets').json()['collections']
    character = next(c for c in catalogue if c['kind']=='character' and c['id']=='101')
    scene = next(c for c in catalogue if c['kind']=='scene' and c['id']=='101')
    cid, sid = character['items'][0]['id'],scene['items'][0]['id']
    for kind, item in [('character',cid),('scene',sid)]:
        response=client.get(f'/api/material-presets/{kind}/101/{item}/gallery')
        assert response.status_code==200,response.text
        body=response.json()
        assert (body['kind'],body['collection_id'],body['item_id'])==(kind,'101',item)
        assert body['total']==len(body['items'])>0
        assert body['cached_count']==sum(bool(x.get('url')) and not x.get('uncached') for x in body['items'])
        assert len({str(x['id']) for x in body['items']})==body['total']
    assert client.get(f'/api/material-presets/scene/101/{cid}/gallery').status_code==404
    assert client.get(f'/api/material-presets/character/missing/{cid}/gallery').status_code==404
    assert client.get('/api/material-presets/invalid/101/item/gallery').status_code==404


def test_gallery_lookup_for_known_prop_is_empty(client):
    catalogue=client.get('/api/material-presets').json()['collections']
    prop=next(c for c in catalogue if c['kind']=='prop')
    response=client.get(f"/api/material-presets/prop/{prop['id']}/{prop['items'][0]['id']}/gallery")
    assert response.status_code==200,response.text
    assert response.json()['items']==[]
    assert response.json()['total']==response.json()['cached_count']==0


def test_gallery_lookup_does_not_modify_personal_materials_or_credits(client):
    catalogue=client.get('/api/material-presets').json()['collections'][0]
    credits=client.get('/api/credits').json()
    assets=client.get('/api/assets').json()
    response=client.get(f"/api/material-presets/{catalogue['kind']}/{catalogue['id']}/{catalogue['items'][0]['id']}/gallery")
    assert response.status_code==200,response.text
    assert client.get('/api/credits').json()==credits
    assert client.get('/api/assets').json()==assets
