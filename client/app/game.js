'use strict';

var _ = require('lodash')
    , utils = require('../../shared/utils')
    , List = require('../../shared/utils/list')
    , Wall = require('../../shared/core/wall')
    , World = require('../../shared/physics/world')
    , Body = require('../../shared/physics/body')
    , EntityHashmap = require('../../shared/utils/entityHashmap')
    , StateHistory = require('../../shared/utils/stateHistory')
    , TextManager = require('./ui/textManager')
    , Entity = require('../../shared/core/entity')
    , IoComponent = require('../../shared/components/io')
    , PhysicsComponent = require('../../shared/components/physics')
    , AttackComponent = require('./components/attack')
    , FlagComponent = require('./components/flag')
    , InputComponent = require('./components/input')
    , PlayerComponent = require('./components/player')
    , SpriteComponent = require('./components/sprite')
    , SyncComponent = require('./components/sync');

/**
 * Runs the game.
 * @param {Primus.Client} primus - Client instance.
 * @param {object} config - Game configuration.
 */
function run(primus, config) {
    /**
     * Play state class.
     * @class client.PlayState
     * @classdesc Game state that runs the actual game play.
     * @extends Phaser.State
     */
    var PlayState = utils.inherit(Phaser.State, {
        /**
         * Creates a new game state.
         * @constructor
         */
        constructor: function() {
            /**
             * @property {shared.EntityHashmap} entities - Map over entities in the state.
             */
            this.entities = new EntityHashmap();
            /**
             * @property {shared.core.Entity} player - Player entity.
             */
            this.player = null;
            /**
             * @property {shared.physics.World} foo - World instance.
             */
            this.foo = new World(config.gameWidth, config.gameHeight);

            // internal properties
            this._ping = 0;
            this._pingSentAt = null;
            this._packetsReceived = new List();
            this._runTimeSec = 0;
            this._teamFlagCount = 0;
            this._totalFlagCount = 0;
            this._totalPlayerCount = 0;
            this._score = '';
            this._entityGroup = null;
            this._effectGroup = null;
            this._music = null;
            this._stateHistory = new StateHistory((1000 / config.syncRate) * 3);
            this._lastSyncAt = null;
            this._lastTickAt = null;

            this._texts = new TextManager();
        }
        /**
         * Loads the game assets.
         * @method client.PlayState#preload
         * @param {Phaser.Game} game - Game instance.
         */
        , preload: function(game) {
            this.log('creating client', config);
            this.log('loading assets ...');

            this.load.tilemap(config.mapKey, null, config.mapData, config.mapType);
            this.loadAssets(game);
        }
        /**
         * Loads game assets.
         * @param {Phaser.Game} game - Game instance.
         */
        , loadAssets: function() {
            // load images
            _.forOwn(config.images, function(src, key) {
                this.load.image(key, 'static/assets/' + src);
            }, this);

            // load spritesheets
            _.forOwn(config.spritesheets, function(spritesheet, key) {
                this.load.spritesheet(
                    key
                    , 'static/assets/' + spritesheet.src
                    , spritesheet.width
                    , spritesheet.height
                    , spritesheet.frames
                );
            }, this);

            // load audio
            _.forOwn(config.audio, function(files, key) {
                _.forOwn(files, function(src, index) {
                    files[index] = 'static/assets/' + src;
                }, this);

                this.load.audio(key, files);
            }, this);
        }
        /**
         * Creates the game objects.
         * @method client.PlayState#creeate
         * @param {Phaser.Game} game - Game instance.
         */
        , create: function(game) {
            this.log('creating game ...');

            var map, layer, wall, body, style, text, pauseKey, muteKey;

            // remove all existing key bindings
            this.game.input.reset(true/* hard */);

            // define the world bounds
            this.world.setBounds(0, 0, config.gameWidth, config.gameHeight);

            // set the background color for the stage
            this.stage.backgroundColor = '#000';

            // create the map
            map = this.add.tilemap(config.mapKey);
            map.addTilesetImage(config.mapKey, config.mapImage);
            _.forOwn(config.mapLayer, function(layerData) {
                layer = map.createLayer(layerData);
                if (layer) {
                    layer.resizeWorld();
                }
            }, this);

            // add the collision layer tiles to the physical world
            _.forOwn(config.mapWalls, function(json) {
                console.log(json);
                wall = new Wall(json.x, json.y, json.width, json.height);

                body = new Body('wall', wall);
                body.x = wall.x;
                body.y = wall.y;
                body.width = wall.width;
                body.height = wall.height;

                this.foo.add(body);
            }, this);

            // create the music
            this._music = this.add.audio(
                config.mapMusic
                , 0.1/* volume */
                , true/* loop */
            );
            this._music.play();

            this._entityGroup = this.add.group();
            this._effectGroup = this.add.group();

            // TODO clean up the text creation

            style = {
                font: "14px Courier"
                , stroke: "#000000"
                , strokeThickness: 5
                , fill: "#ffffff"
            };

            text = this.add.text(10, 10, '', style);
            text.fixedToCamera = true;
            this._texts.add('gameScore', text);

            text = this.add.text(10, config.canvasHeight - 90, 'points: -', style);
            text.fixedToCamera = true;
            this._texts.add('playerPoints', text);

            text = this.add.text(10, config.canvasHeight - 50, 'kills: - / deaths: -', style);
            text.fixedToCamera = true;
            this._texts.add('playerStats', text);

            text = this.add.text(10, config.canvasHeight - 70, 'flags: - / -', style);
            text.fixedToCamera = true;
            this._texts.add('teamFlags', text);

            text = this.add.text(10, config.canvasHeight - 30, 'time left: -', style);
            text.fixedToCamera = true;
            this._texts.add('gameTimeLeft', text);

            text = this.add.text(config.canvasWidth - 10, config.canvasHeight - 70, 'ping: -', style);
            text.anchor.x = 1;
            text.fixedToCamera = true;
            this._texts.add('clientPing', text);

            text = this.add.text(config.canvasWidth - 10, config.canvasHeight - 50, 'packet loss: -', style);
            text.anchor.x = 1;
            text.fixedToCamera = true;
            this._texts.add('clientPacketLoss', text);

            text = this.add.text(config.canvasWidth - 10, config.canvasHeight - 30, 'players online: -', style);
            text.anchor.x = 1;
            text.fixedToCamera = true;
            this._texts.add('playersOnline', text);

            text = this.add.text(config.canvasWidth - 10, 10, config.gameName + ' ' + config.gameVersion, style);
            text.anchor.x = 1;
            text.fixedToCamera = true;

            style = {
                font: '24px Courier'
                , stroke: '#000000'
                , strokeThickness: 5
                , fill: '#ffffff'
                , align: 'center'
            };

            text = this.add.text(config.canvasWidth / 2, config.canvasHeight / 2, '', style);
            text.anchor.setTo(0.5, 0.5);
            text.fixedToCamera = true;
            this._texts.add('gameResult', text);

            if (DEBUG) {
                pauseKey = game.input.keyboard.addKey(Phaser.Keyboard.P);
                pauseKey.onDown.add(this.onGamePause.bind(this));
            }

            muteKey = game.input.keyboard.addKey(Phaser.Keyboard.M);
            muteKey.onDown.add(this.onMusicMuted.bind(this));

            // bind event handlers
            primus.on('pong', this.onPong.bind(this));
            primus.on('player.create', this.onPlayerCreate.bind(this));
            primus.on('player.leave', this.onPlayerLeave.bind(this));
            primus.on('game.end', this.onGameEnd.bind(this));

            // let the server know that client is ready
            primus.emit('client.ready');
        }
        /**
         * Event handler for when the game is paused.
         * @method client.PlayState#onGamePause
         */
        , onGamePause: function() {
            this.paused = !this.paused;
            this.log(this.paused ? 'game paused' : 'game resumed');
        }
        /**
         * TODO
         */
        , onGameEnd: function(winner) {
            this.player.remove();
            this._texts.changeText('gameResult', winner.toUpperCase() + ' TEAM WON\nGame will restart shortly');
        }
        /**
         * Event handler for when mute is pressed.
         * @method client.PlayState#onMusicMuted
         */
        , onMusicMuted: function() {
            this._music.mute = !this._music.mute;
            this.log(this._music.mute ? 'game music muted' : 'game music unmuted');
        }
        /**
         * Event handler for creating the player.
         * @method client.PlayState#onPlayerCreate
         * @param {object} state - Player state.
         */
        , onPlayerCreate: function(state) {
            this.log('creating player', state);

            // TODO move this logic to the entity factory
            var entity = this.createEntity(state)
                , sprites = {
                    player: this._entityGroup.create(state.attrs.x, state.attrs.y, state.attrs.image)
                    , grave: this._entityGroup.create(state.attrs.x, state.attrs.y, 'grave')
                    , attack: this._effectGroup.create(state.attrs.x, state.attrs.y, 'attack-sword')
                }
                , body = new Body('player', entity)
                , nameText = this.createNameText(state.attrs.name, state.attrs.team);

            this.camera.follow(sprites.player);

            entity.components.add(new SpriteComponent(sprites));
            entity.components.add(new PlayerComponent(nameText));
            entity.components.add(new IoComponent(primus));
            entity.components.add(new AttackComponent());
            entity.components.add(new InputComponent(this.game.input));
            entity.components.add(new PhysicsComponent(body, this.foo));

            this.entities.add(state.id, entity);

            this.player = entity;

            // now we are ready to synchronization the world with the server
            primus.on('client.sync', this.onSync.bind(this));
        }
        /**
         * TODO
         */
        , createNameText: function(name, team) {
            var color = team === 'red' ? '#ff33cc' : '#0099ff';
            return this.add.text(0, 0, name, {font: "10px Courier", stroke: "#000000", strokeThickness: 5, fill: color});
        }
        /**
         * Event handler for synchronizing the client with the server.
         * @method client.PlayState#onSync
         * @param {object} worldState - World state.
         */
        , onSync: function(worldState) {
            var now = _.now();

            // TODO The timestamp should probably not be set like this
            worldState.timestamp = now;
            this._stateHistory.snapshot(worldState);
            this._packetsReceived.add(worldState.sequence);

            this._lastSyncAt = now;
        }
        /**
         * Event handler for when a player leaves.
         * @method client.PlayState#onPlayerLeave
         * @param {string} id - Player entity identifier.
         */
        , onPlayerLeave: function (entityId) {
            this.log('player left', entityId);

            var entity = this.entities.get(entityId);
            if (entity) {
                entity.remove();
            }
        }
        /**
         * Updates the logic for this game.
         * @method client.PlayState#update
         * @param {Phaser.Game} game - Game instance.
         */
        , update: function(game) {
            var now = _.now()
                , elapsed = (now - this._lastTickAt) / 1000;

            this.updateWorldState();
            this.updateEntities(elapsed);
            this.updateTexts();

            this._entityGroup.sort('y', Phaser.Group.SORT_ASCENDING);

            this._lastTickAt = now;
        }
        /**
         * Updates the entities in the state.
         * @method client.PlayState#updateEntities
         */
        , updateEntities: function(elapsed) {
            this.entities.each(function(entity, id) {
                entity.update(elapsed);
            }, this);
        }
        /**
         * Updates the game text.
         * @method client.PlayState#updateTexts
         */
        , updateTexts: function() {
            var now = _.now()
                , timeLeftSec;

            this._texts.changeText('gameScore', this._score);

            if (this.player) {
                var points = this.player.attrs.get('points')
                    , stats = this.player.attrs.get(['kills', 'deaths']);

                if (_.isNumber(points)) {
                    this._texts.changeText('playerPoints', 'points: ' + Math.round(points));
                }

                if (_.isNumber(stats.kills) && _.isNumber(stats.deaths)) {
                    this._texts.changeText('playerStats', 'kills: ' + stats.kills + ' / deaths: ' + stats.deaths);
                }
            }

            if (_.isNumber(this._teamFlagCount) && _.isNumber(this._totalFlagCount)) {
                this._texts.changeText('teamFlags', 'flags: ' + this._teamFlagCount + ' / ' + this._totalFlagCount);
            }

            timeLeftSec = config.gameLengthSec - Math.round(this._runTimeSec);
            this._texts.changeText('gameTimeLeft', 'time left: ' + timeLeftSec + ' sec');

            this._pingSentAt = this._pingSentAt || now;
            if ((now - this._pingSentAt) > 250) {
                var ping = Math.round(this._ping / 10) * 10;
                if (ping < 10) {
                    ping = 10;
                }
                this._texts.changeText('clientPing', 'ping: ' + ping + ' ms');
                primus.emit('ping', {timestamp: now});
                this._pingSentAt = now;
            }

            var packetSequence = this._packetsReceived.last();
            if (packetSequence % 10 === 0) {
                var packetsReceived = this._packetsReceived.size()
                    , packetsLost = 10 - packetsReceived
                    , packetLoss = packetsLost === 0 ? packetsLost / packetsReceived : 0;
                this._texts.changeText('clientPacketLoss', 'packet loss: ' + packetLoss.toFixed(1) + '%');
                this._packetsReceived.clear();
            }

            this._texts.changeText('playersOnline', 'players online: ' + this._totalPlayerCount);
        }
        /**
         * Event handler for when receiving a ping response.
         * @method client.PlayState#onPong
         * @param {object} ping - Ping object.
         */
        , onPong: function(ping) {
            this._ping = _.now() - ping.timestamp;
        }
        /**
         * Updates the world state using the state history.
         * @method client.PlayState#updateWorldState
         */
        , updateWorldState: function() {
            var worldState = this._stateHistory.last();

            if (worldState) {
                var now = _.now()
                    , playerTeam = this.player.attrs.get('team')
                    , previousState = null //this._stateHistory.previous()
                    , factor, state, entity, sprites, body, nameText;

                this._runTimeSec = worldState.runTimeSec;
                this._teamFlagCount = worldState.flags[playerTeam].length;
                this._totalFlagCount = worldState.flagCount;
                this._totalPlayerCount = worldState.playerCount;
                this._score = this.createTeamScoreText(worldState.teamScore);

                if (previousState) {
                    if (config.enableInterpolation && this.canInterpolate()) {
                        // TODO fix client interpolation
                        factor = this.calculateInterpolationFactor(previousState, worldState);
                        worldState = this.interpolateWorldState(previousState, worldState, factor);
                    }
                    /*
                    else if (config.enableExtrapolation && this.canExtrapolate()) {
                        // TODO add support for world state extrapolation
                        factor = 1;
                        worldState = this.extrapolateWorldState(previousState, worldState, factor);
                    }
                    */
                }

                _.forOwn(worldState.entities, function(state, entityId) {
                    entity = this.entities.get(entityId);

                    // if the entity does not exist, we need to create it
                    if (!entity) {
                        this.log('creating new entity', state);
                        entity = this.createEntity(state);
                        body = new Body(state.key, entity);

                        // all entities should be synchronized
                        entity.components.add(new SyncComponent());
                        entity.components.add(new PhysicsComponent(body, this.foo));

                        // TODO move this logic to the entity factory
                        switch (state.key) {
                            case 'player':
                                sprites = {
                                    player: this._entityGroup.create(state.attrs.x, state.attrs.y, state.attrs.image)
                                    , attack: this._effectGroup.create(state.attrs.x, state.attrs.y, 'attack-sword')
                                    , grave: this._entityGroup.create(state.attrs.x, state.attrs.y, 'grave')
                                };
                                nameText = this.createNameText(state.attrs.name, state.attrs.team);

                                entity.components.add(new SpriteComponent(sprites));
                                entity.components.add(new PlayerComponent(nameText));
                                entity.components.add(new AttackComponent());
                                break;
                            case 'flag':
                                sprites = {
                                    flag: this._entityGroup.create(state.attrs.x, state.attrs.y, state.attrs.image)
                                };

                                entity.components.add(new SpriteComponent(sprites));
                                entity.components.add(new FlagComponent());
                                break;
                            default:
                                break;
                        }

                        this.entities.add(entityId, entity);
                    }

                    entity.sync(state.attrs);
                }, this);
            }
        }
        /**
         * TODO
         */
        , createTeamScoreText: function(scores) {
            var text = '';
            _.forOwn(scores, function(score) {
                text += score.team + ' team: ' + score.points + '\n';
            });
            return text;
        }
        /**
         * Calculates an interpolation factor based on the two given snapshots.
         * @method client.PlayState#calculateInterpolationFactor
         * @param {object} previous - Previous snapshot.
         * @param {object} next - Next snapshot.
         * @return {number} Interpolation factory (a number between 0 and 1).
         */
        , calculateInterpolationFactor: function(previous, next) {
            var lerpMsec = (1000 / config.syncRate) * 2
                , lerpTime = this._lastTickAt - lerpMsec
                , delta = lerpTime - previous.timestamp
                , timestep = next.timestamp - previous.timestamp;

            return delta / timestep;
        }
        /**
         * Returns whether the state can be interpolated.
         * @method client.PlayState#canInterpolate
         * @return {boolean} The result.
         */
        , canInterpolate: function() {
            var endTime = _.now() - (1000 / config.syncRate)
                , last = this._stateHistory.last();

            return this._stateHistory.size() >= 2 && last.timestamp < endTime;
        }
        /**
          * Returns whether the state can be extrapolated.
          * @method client.PlayState#canExtrapolate
          * @return {boolean} The result.
          */
        , canExtrapolate: function() {
            var now = _.now()
                , startTime = now - (1000 / config.syncRate)
                , endTime = now - config.extrapolationMsec
                , last = this._stateHistory.last();

            return this._stateHistory.size() >= 2 && last.timestamp < startTime && last.timestamp > endTime;
        }
        /**
         * Creates an approximate snapshot of the world state using linear interpolation.
         * @method client.PlayState#interpolateWorldState
         * @param {object} previous - Previous snapshot.
         * @param {object} next - Next snapshot.
         * @return {object} Interpolated world state.
         */
        , interpolateWorldState: function(previous, next, factor) {
            var worldState = _.clone(next)
                , entityState;

            if (factor >= 0 && factor <= 1) {
                _.forOwn(next.entities, function(entity, id) {
                    if (previous.entities[id]) {
                        entityState = this.interpolateEntityState(
                            previous.entities[id]
                            , entity
                            , factor
                        );
                        // TODO Check this "smoothing" is necessary
                        /*
                        entityState = this.interpolateEntityState(
                            previous.entities[id]
                            , entityState
                            , 0.3
                        );
                        */
                        worldState.entities[id] = entityState;
                    }
                }, this);
            }

            return worldState;
        }
        /**
         * Creates an approximate snapshot of an entity.
         * @method client.PlayState#interpolateEntityState
         * @param {object} previous - Previous snapshot.
         * @param {object} next - Next snapshot.
         * @return {object} Interpolated entity state.
         */
        , interpolateEntityState: function(previous, next, factor) {
            var entityState = _.clone(next)
                , previousValue;

            _.forOwn(next.attrs, function(value, name) {
                previousValue = previous.attrs[name];
                if (this.canInterpolateValue(previousValue, value)) {
                    entityState.attrs[name] = utils.lerp(previousValue, value, factor);
                }
            }, this);

            return entityState;
        }
        /**
         * Returns whether the given value can be interpolated.
         * @method client.PlayState#canInterpolateValue
         * @param {object} previous - Previous value.
         * @param {object} next - Next value.
         * @return {boolean} The result.
         */
        , canInterpolateValue: function(previous, next) {
            return _.isNumber(next) && !_.isUndefined(previous);
        }
        /**
         * Creates an approximate snapshot of the world state using linear extrapolation.
         * @method client.PlayState#extrapolateWorldState
         * @param {object} previous - Previous snapshot.
         * @param {object} next - Next snapshot.
         * @param {number} factor - Interpolation factor.
         * @return {object} Interpolated world state.
         */
        , extrapolateWorldState: function(previous, next, factor) {
            // TODO implement extrapolation
            return next;
        }
        /**
         * Creates a new entity.
         * @method client.PlayState#createEntity
         * @param {object} data - Entity data.
         */
        , createEntity: function(data) {
            return new Entity(data, config);
        }
        /**
         * Logs the a message to the console.
         */
        , log: function() {
             if (DEBUG && typeof console !== 'undefined') {
                 console.log.apply(console, arguments);
             }
         }
    });

    // create the actual game
    var game = new Phaser.Game(
        config.canvasWidth
        , config.canvasHeight
        , Phaser.CANVAS
        , 'game'
        , null/* state */
        , false/* transparent */
        , false/* antialias */
    );

    game.state.add('play', new PlayState(), true/* autostart */);
}

module.exports = {
    run: run
};
